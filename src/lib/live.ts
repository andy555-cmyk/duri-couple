/**
 * Real-time interpreting over the Gemini Live API (WebSocket).
 *
 * Measured 2026-10-09 (duri-lab/live): the general Live model with our couple instructions, a 1 s pause
 * setting and END_SENSITIVITY_LOW translated both directions correctly in casual speech, starting
 * ~1.1 s after the speaker stopped (the record-then-send path needs ~2.5–3 s). The translate-only
 * model is faster on long speech but always answers Korean politely and takes no instructions, so it
 * is not the default.
 *
 * Built from Codex's prototype (duri-lab/live/browser-sketch.ts) with: model fallback, reconnects,
 * a level meter, and a half-duplex gate so the phone's own translated voice is never re-translated.
 */
import { setAudioSession } from './audio';
import { runLiveMock } from './mock';

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const LIVE_MODELS = ['gemini-3.8-live', 'gemini-3.1-flash-live-preview'];

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
  speak: boolean;

  constructor(
    private cfg: LiveConfig,
    private cb: LiveCallbacks,
  ) {
    this.speak = cfg.speak;
  }

  private get models() {
    return this.cfg.models?.length ? this.cfg.models : LIVE_MODELS;
  }

  get model() {
    return this.models[this.modelIndex];
  }

  private stopMock?: () => void;

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
    setAudioSession('playback');
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
    this.node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      const { pcm, level } = event.data;
      // While the phone is speaking a translation, the mic would hear it: send silence instead.
      const echo = this.speak && performance.now() < this.quietUntil;
      this.cb.onLevel?.(echo ? 0 : Math.min(1, level * 4));
      this.send(echo ? this.silence : pcm);
    };
    this.source.connect(this.node).connect(this.sink).connect(ctx.destination);
  }

  private send(pcm: ArrayBuffer) {
    const ws = this.ws;
    if (!this.ready || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: toBase64(pcm), mimeType: 'audio/pcm;rate=16000' } } }));
  }

  private connect() {
    if (this.stopped) return;
    const model = this.model;
    const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.cfg.key)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.ready = false;
    let setupDone = false;
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${model}`,
            generationConfig: { responseModalities: ['AUDIO'] },
            systemInstruction: { parts: [{ text: this.cfg.system }] },
            realtimeInputConfig: {
              automaticActivityDetection: { silenceDurationMs: 1000, endOfSpeechSensitivity: 'END_SENSITIVITY_LOW' },
            },
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
        this.reconnects = 0;
        this.cb.onState?.('listening');
        return;
      }
      if (message.goAway) {
        // The server is about to end this session (time limit): open a fresh one now.
        this.reconnect(ws, 0);
        return;
      }
      this.handle(message.serverContent, model);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws || this.stopped) return;
      this.ready = false;
      if (!setupDone) {
        const failure = classifyClose(event.code, event.reason || '');
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
  }

  private reconnect(old: WebSocket, delay: number) {
    if (this.stopped) return;
    if (this.reconnects++ >= 4) {
      this.fail('network');
      return;
    }
    this.cb.onState?.('reconnecting');
    this.ws = undefined;
    try {
      old.close(1000, 'reconnect');
    } catch {
      /* ignore */
    }
    window.setTimeout(() => this.connect(), delay);
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
      if (this.cur.input.trim() || this.cur.output.trim()) this.cb.onTurn?.({ ...this.cur, model });
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
