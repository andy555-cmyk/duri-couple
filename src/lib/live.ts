/**
 * Real-time interpreting over the Gemini Live API (WebSocket).
 *
 * Measured 2026-10-09 (duri-lab/live): the general Live model with our couple instructions translated
 * both directions correctly in casual speech (the record-then-send path needs ~2.5–3 s). The
 * translate-only model is faster on long speech but always answers Korean politely and takes no
 * instructions, so it is not the default.
 * 2026-10-10 (tools/live-ws-check.mjs): Google's automatic end-of-speech detection cut the second
 * sentence of a session short and dropped the rest, so the app marks each turn itself (TurnGate):
 * every turn came back whole, translation audio starting 1.1–1.4 s after the speaker stopped.
 *
 * Built from Codex's prototype (duri-lab/live/browser-sketch.ts) with: model fallback, reconnects,
 * a level meter, and a half-duplex gate so the phone's own translated voice is never re-translated.
 */
import { setAudioSession, TurnGate } from './audio';
import { runLiveMock } from './mock';

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const LIVE_MODELS = ['gemini-3.8-live', 'gemini-3.1-flash-live-preview'];
/** A socket that opens but never confirms setup must not keep the mic on (Codex review2 H2). */
export const SETUP_TIMEOUT_MS = 10_000;
/** Reconnect attempts reset only after the line has proved itself (Codex review2 M2). */
const STABLE_MS = 30_000;
const MAX_RECONNECTS = 4;

// The interpreter that currently owns the phone's audio mode; a late stop() of an older one must not
// switch the session back to playback under a newer one that is recording.
let audioOwner: LiveInterpreter | null = null;

export type LiveState = 'idle' | 'connecting' | 'listening' | 'translating' | 'reconnecting' | 'error';
export type LiveFailure = 'unsupported' | 'denied' | 'key' | 'quota' | 'busy' | 'network';

export interface LiveCaption {
  input: string;
  output: string;
}

export interface LiveCallbacks {
  onState?: (state: LiveState, failure?: LiveFailure) => void;
  onLevel?: (level: number) => void;
  onCaption?: (caption: LiveCaption) => void;
  onTurn?: (turn: LiveCaption & { model: string }) => void;
}

export interface LiveConfig {
  key: string;
  system: string;
  speak: boolean;
  models?: string[];
  /** Quiet that ends a turn (ms); the app marks turns itself (see TurnGate). */
  endMs?: number;
}

export function liveSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof WebSocket !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    !!(window.AudioContext || (window as any).webkitAudioContext)
  );
}

/** Close codes and reasons → what to tell the person. */
export function classifyClose(code: number, reason: string): LiveFailure {
  const r = reason.toLowerCase();
  if (r.includes('api key') || r.includes('api_key') || r.includes('permission') || r.includes('unauthenticated')) return 'key';
  if (r.includes('quota') || r.includes('resource_exhausted') || r.includes('rate')) return 'quota';
  if (code === 1006) return 'network';
  return 'busy';
}

// Downsamples the mic to 16 kHz mono PCM16 and posts 100 ms chunks plus their loudness.
const WORKLET = `
class Pcm16Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0; this.sum = 0; this.count = 0;
    this.chunk = new Int16Array(1600); this.offset = 0;
    this.sq = 0; this.n = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      this.sq += x * x; this.n++;
      this.sum += x; this.count++;
      this.phase += 16000;
      if (this.phase >= sampleRate) {
        const v = Math.max(-1, Math.min(1, this.sum / this.count));
        this.chunk[this.offset++] = v < 0 ? v * 32768 : v * 32767;
        this.phase -= sampleRate; this.sum = 0; this.count = 0;
        if (this.offset === this.chunk.length) {
          const level = Math.sqrt(this.sq / Math.max(1, this.n));
          const pcm = this.chunk.buffer;
          this.port.postMessage({ pcm, level }, [pcm]);
          this.chunk = new Int16Array(1600); this.offset = 0; this.sq = 0; this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm16-capture', Pcm16Capture);
`;

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class LiveInterpreter {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private node?: AudioWorkletNode;
  private sink?: GainNode;
  private ws?: WebSocket;
  private ready = false;
  private stopped = false;
  private modelIndex = 0;
  private reconnects = 0;
  private playAt = 0;
  private quietUntil = 0;
  private playing = new Set<AudioBufferSourceNode>();
  private cur: LiveCaption = { input: '', output: '' };
  private silence = new Int16Array(1600).buffer;
  private timers = new Set<number>();
  private gate: TurnGate;
  private inTurn = false;
  private preroll: ArrayBuffer[] = [];
  speak: boolean;

  constructor(
    private cfg: LiveConfig,
    private cb: LiveCallbacks,
  ) {
    this.speak = cfg.speak;
    this.gate = new TurnGate(cfg.endMs ?? 700);
  }

  private get models() {
    return this.cfg.models?.length ? this.cfg.models : LIVE_MODELS;
  }

  get model() {
    return this.models[this.modelIndex];
  }

  private stopMock?: () => void;

  private later(fn: () => void, ms: number) {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  private cancel(id: number | undefined) {
    if (id === undefined) return;
    clearTimeout(id);
    this.timers.delete(id);
  }

  /** Call from inside a tap: iOS only opens sound for an AudioContext created before the first await. */
  async start() {
    if (import.meta.env.DEV && this.cfg.key === 'mock') {
      this.cb.onState?.('connecting');
      this.stopMock = runLiveMock(
        (content) => this.handle(content, 'mock-live'),
        (v) => this.cb.onLevel?.(v),
        () => this.cb.onState?.('listening'),
      );
      return;
    }
    if (!liveSupported()) throw new Error('unsupported' satisfies LiveFailure);
    audioOwner = this;
    setAudioSession('play-and-record');
    const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AC();
    const resumed = this.ctx.resume().catch(() => {});
    this.cb.onState?.('connecting');
    let stream: MediaStream;
    try {
      [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
        resumed,
      ]);
    } catch {
      await this.stop();
      throw new Error('denied' satisfies LiveFailure);
    }
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    try {
      await this.attachMic(stream);
    } catch {
      await this.stop();
      throw new Error('unsupported' satisfies LiveFailure);
    }
    this.connect();
  }

  setSpeak(on: boolean) {
    this.speak = on;
    if (!on) this.stopPlayback();
  }

  async stop() {
    this.stopMock?.();
    this.stopMock = undefined;
    this.stopped = true;
    this.ready = false;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close(1000, 'done');
    } catch {
      /* already closed */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stopPlayback();
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close().catch(() => {});
    this.ctx = undefined;
    if (audioOwner === this) {
      audioOwner = null;
      setAudioSession('playback');
    }
    this.cb.onLevel?.(0);
    this.cb.onState?.('idle');
  }

  private async attachMic(stream: MediaStream) {
    const ctx = this.ctx!;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.source = ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(ctx, 'pcm16-capture');
    // Safari stops a worklet that is not connected to the output, so route it there at zero volume.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => this.feed(event.data.pcm, event.data.level);
    this.source.connect(this.node).connect(this.sink).connect(ctx.destination);
  }

  /**
   * One 100 ms mic chunk (PCM16 at 16 kHz and its RMS). The app marks where each utterance starts and
   * ends; 0.4 s from before the start goes along so the first syllable is not lost.
   */
  feed(pcm: ArrayBuffer, rms: number) {
    // While the phone is speaking a translation, the mic would hear it: treat it as silence.
    const echo = this.speak && performance.now() < this.quietUntil;
    const level = echo ? 0 : Math.min(1, rms * 4);
    const chunk = echo ? this.silence : pcm;
    this.cb.onLevel?.(level);
    const event = this.gate.feed(level, 100);
    if (!this.ready) return;
    if (!this.inTurn) {
      this.preroll.push(chunk);
      if (this.preroll.length > 4) this.preroll.shift();
      if (event !== 'start') return;
      this.inTurn = true;
      this.sendJson({ realtimeInput: { activityStart: {} } });
      for (const piece of this.preroll) this.send(piece);
      this.preroll = [];
      return;
    }
    this.send(chunk);
    if (event === 'end') {
      this.inTurn = false;
      this.sendJson({ realtimeInput: { activityEnd: {} } });
    }
  }

  private sendJson(message: unknown) {
    const ws = this.ws;
    if (!this.ready || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  private send(pcm: ArrayBuffer) {
    this.sendJson({ realtimeInput: { audio: { data: toBase64(pcm), mimeType: 'audio/pcm;rate=16000' } } });
  }

  private connect() {
    if (this.stopped) return;
    const model = this.model;
    const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.cfg.key)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.ready = false;
    let setupDone = false;
    let ended = false;
    let stable: number | undefined;
    // One place decides what happens when this socket stops working, however that shows up.
    const end = (failure: LiveFailure) => {
      if (ended) return;
      ended = true;
      this.cancel(setupTimer);
      this.cancel(stable);
      if (this.ws !== ws || this.stopped) return;
      this.ready = false;
      if (!setupDone) {
        this.ws = undefined;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (failure !== 'key' && this.modelIndex < this.models.length - 1) {
          this.modelIndex++;
          this.connect();
          return;
        }
        this.fail(failure);
        return;
      }
      this.reconnect(ws, 300 * (this.reconnects + 1));
    };
    const setupTimer = this.later(() => end('busy'), SETUP_TIMEOUT_MS);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${model}`,
            generationConfig: { responseModalities: ['AUDIO'] },
            systemInstruction: { parts: [{ text: this.cfg.system }] },
            // The app marks each turn itself (TurnGate): Google's own detection cut sentences short.
            realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        }),
      );
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      let message: any;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.setupComplete) {
        setupDone = true;
        this.ready = true;
        // A fresh line starts between turns; someone still talking is picked up again within 0.2 s.
        this.gate.reset();
        this.inTurn = false;
        this.preroll = [];
        this.cancel(setupTimer);
        stable = this.later(() => (this.reconnects = 0), STABLE_MS);
        this.cb.onState?.('listening');
        return;
      }
      if (message.goAway) {
        // The server is about to end this session (time limit): open a fresh one now.
        ended = true;
        this.cancel(stable);
        this.reconnect(ws, 0);
        return;
      }
      this.handle(message.serverContent, model);
    };
    ws.onclose = (event) => end(classifyClose(event.code, event.reason || ''));
  }

  private reconnect(old: WebSocket, delay: number) {
    if (this.stopped) return;
    if (this.reconnects++ >= MAX_RECONNECTS) {
      this.fail('network');
      return;
    }
    this.cb.onState?.('reconnecting');
    this.ws = undefined;
    this.ready = false;
    try {
      old.close(1000, 'reconnect');
    } catch {
      /* ignore */
    }
    // Half a sentence from the old line cannot be finished on the new one.
    this.cur = { input: '', output: '' };
    this.cb.onCaption?.({ ...this.cur });
    this.later(() => this.connect(), delay);
  }

  private handle(content: any, model: string) {
    if (!content) return;
    if (content.interrupted) this.stopPlayback();
    let changed = false;
    if (content.inputTranscription?.text) {
      this.cur.input += content.inputTranscription.text;
      changed = true;
    }
    if (content.outputTranscription?.text) {
      this.cur.output += content.outputTranscription.text;
      changed = true;
      this.cb.onState?.('translating');
    }
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && this.speak) this.play(part.inlineData.data);
    }
    if (changed) this.cb.onCaption?.({ ...this.cur });
    if (content.turnComplete) {
      if (this.cur.input.trim() || this.cur.output.trim()) {
        this.reconnects = 0;
        this.cb.onTurn?.({ ...this.cur, model });
      }
      this.cur = { input: '', output: '' };
      this.cb.onCaption?.({ ...this.cur });
      this.cb.onState?.('listening');
    }
  }

  private play(base64: string) {
    const ctx = this.ctx;
    if (!ctx) return;
    const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const samples = raw.byteLength >> 1;
    if (!samples) return;
    const view = new DataView(raw.buffer);
    const buffer = ctx.createBuffer(1, samples, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    this.playAt = Math.max(this.playAt, ctx.currentTime + 0.03);
    node.start(this.playAt);
    this.playAt += buffer.duration;
    this.quietUntil = performance.now() + (this.playAt - ctx.currentTime) * 1000 + 350;
    this.playing.add(node);
    node.onended = () => this.playing.delete(node);
  }

  private stopPlayback() {
    for (const node of this.playing) {
      try {
        node.stop();
      } catch {
        /* already ended */
      }
    }
    this.playing.clear();
    this.playAt = 0;
    this.quietUntil = 0;
  }

  private fail(failure: LiveFailure) {
    this.cb.onState?.('error', failure);
    void this.stop().then(() => this.cb.onState?.('error', failure));
  }
}
