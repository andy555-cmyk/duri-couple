export interface Recording {
  blob: Blob;
  mime: string;
  ms: number;
  /** null when the level meter was unavailable, so we could not tell. */
  heardSpeech: boolean | null;
}

export type MicError = 'unsupported' | 'denied' | 'short';

const MIME_PREFERENCE = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
// Speech is clear at this rate and the upload is ~3x smaller than Safari's default.
const BITRATE = 48_000;

export function micSupported() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

function pickMime() {
  for (const mime of MIME_PREFERENCE) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      /* older Safari throws on unknown types */
    }
  }
  return '';
}

/**
 * iOS 16.4+ lets a page say what it is doing with sound. Recording switches the phone into
 * call-style audio (quieter, sometimes the earpiece); going back to "playback" afterwards
 * keeps the spoken translation on the loudspeaker at full volume.
 */
export function setAudioSession(type: 'playback' | 'play-and-record' | 'auto') {
  try {
    const session = (navigator as any).audioSession;
    if (session && session.type !== type) session.type = type;
  } catch {
    /* not supported */
  }
}

export type GateEvent = 'none' | 'speech' | 'end' | 'nothing';

/**
 * Decides when someone has finished talking, from the mic level alone.
 * It learns the room's noise floor, needs a quarter second of voice to count as speech,
 * then fires 'end' after `silenceMs` of quiet. 'nothing' means no speech at all for `idleMs`.
 */
export class SpeechGate {
  floor = 0.04;
  voiced = 0;
  quiet = 0;
  heard = false;
  elapsed = 0;
  private fired = false;

  constructor(
    private silenceMs = 1500,
    private idleMs = 9000,
  ) {}

  get threshold() {
    return Math.max(0.12, this.floor * 3);
  }

  feed(level: number, dt: number): GateEvent {
    if (this.fired) return 'none';
    this.elapsed += dt;
    if (level > this.threshold) {
      this.voiced += dt;
      this.quiet = 0;
      if (!this.heard && this.voiced >= 250) {
        this.heard = true;
        return 'speech';
      }
      return 'none';
    }
    // Quiet: follow the noise floor slowly, and count the silence.
    this.floor = this.floor * 0.97 + level * 0.03;
    if (this.heard) {
      this.quiet += dt;
      if (this.quiet >= this.silenceMs) {
        this.fired = true;
        return 'end';
      }
    } else {
      // Separate bumps or clicks must not add up to "speech": a fifth of a second of quiet starts over
      // (Codex review2 M5). Gaps between syllables are shorter than that.
      this.quiet += dt;
      this.voiced = this.quiet >= 200 ? 0 : Math.max(0, this.voiced - dt * 0.5);
      if (this.elapsed >= this.idleMs) {
        this.fired = true;
        return 'nothing';
      }
    }
    return 'none';
  }
}

/**
 * Continuous turn detection for real-time interpreting: 'start' when someone begins talking, 'end'
 * after `endMs` of quiet (or after `maxMs` of talking, so a long story still gets translated).
 *
 * Measured 2026-10-10 against the real Live API (tools/live-ws-check.mjs, duri-lab/live/manual-vad.mjs):
 * Google's own end-of-speech detection cut the second sentence of a session after a few words and
 * dropped the rest (2 of 3 runs with a 1 s setting, 3 of 3 with 2 s). With the app marking each turn
 * itself, three turns in a row came back whole, first words 0.8–1.1 s after the end mark.
 */
export class TurnGate {
  floor = 0.04;
  speaking = false;
  private voiced = 0;
  private quiet = 0;
  private talked = 0;

  constructor(
    private endMs = 700,
    private maxMs = 20000,
  ) {}

  get threshold() {
    return Math.max(0.12, this.floor * 3);
  }

  reset() {
    this.speaking = false;
    this.voiced = 0;
    this.quiet = 0;
    this.talked = 0;
  }

  feed(level: number, dt: number): 'start' | 'end' | 'none' {
    const loud = level > this.threshold;
    if (!this.speaking) {
      if (loud) {
        this.voiced += dt;
        this.quiet = 0;
        if (this.voiced < 200) return 'none';
        this.speaking = true;
        this.talked = this.voiced;
        this.voiced = 0;
        return 'start';
      }
      // Only the quiet between turns teaches the noise floor; a short gap means the bump was noise.
      this.floor = this.floor * 0.97 + level * 0.03;
      this.quiet += dt;
      if (this.quiet >= 200) this.voiced = 0;
      return 'none';
    }
    this.talked += dt;
    this.quiet = loud ? 0 : this.quiet + dt;
    if (this.quiet < this.endMs && this.talked < this.maxMs) return 'none';
    this.reset();
    return 'end';
  }
}

export interface RecorderOptions {
  onLevel?: (level: number) => void;
  onAutoStop?: () => void;
  /** The browser ended the recording on its own (iOS does this when the app goes to the background). */
  onBroken?: () => void;
  /** Stop by itself once the speaker goes quiet. */
  autoEnd?: boolean;
  silenceMs?: number;
}

/**
 * One recording at a time. No timeslice: Safari then hands back a single, ordinary MP4
 * that Gemini decodes reliably. The level meter (and the auto-stop that depends on it)
 * is optional and never blocks recording.
 */
export class Recorder {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private ctx?: AudioContext;
  private tick = 0;
  private autoStop = 0;
  private started = 0;
  private finish?: (r: Recording | null) => void;
  private discard = false;
  private gate?: SpeechGate;
  private noSpeech = false;
  private cancelled = false;

  constructor(private opts: RecorderOptions = {}) {}

  get active() {
    return !!this.recorder && this.recorder.state === 'recording';
  }

  /** True when the recorder stopped itself because nobody spoke. */
  get stoppedForSilence() {
    return this.noSpeech;
  }

  /** Resolves false if the recording was cancelled while the permission prompt was up. */
  async start(maxMs = 30000): Promise<boolean> {
    if (!micSupported()) throw new Error('unsupported' satisfies MicError);
    setAudioSession('play-and-record');
    // iOS only lets an AudioContext run if it is created inside the tap, i.e. before the first await.
    this.createContext();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      this.cleanup();
      throw new Error('denied' satisfies MicError);
    }
    if (this.cancelled) {
      this.cleanup();
      return false;
    }
    const mime = pickMime();
    try {
      try {
        this.recorder = new MediaRecorder(this.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: BITRATE });
      } catch {
        this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
      }
      this.chunks = [];
      this.discard = false;
      this.noSpeech = false;
      this.gate = this.opts.autoEnd ? new SpeechGate(this.opts.silenceMs ?? 1500) : undefined;
      this.recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) this.chunks.push(event.data);
      };
      const finishOnce = (result: Recording | null) => {
        this.cleanup();
        this.finish?.(this.discard ? null : result);
        this.finish = undefined;
      };
      this.recorder.onstop = () => {
        const type = this.recorder?.mimeType || mime || 'audio/mp4';
        const blob = new Blob(this.chunks, { type });
        finishOnce({ blob, mime: type.split(';')[0] || 'audio/mp4', ms: Date.now() - this.started, heardSpeech: this.gate ? this.gate.heard : null });
      };
      // Safari can report an error instead of stopping (e.g. when sent to the background).
      this.recorder.onerror = () => {
        const waiting = !!this.finish;
        finishOnce(null);
        if (!waiting) this.opts.onBroken?.();
      };
      this.started = Date.now();
      this.recorder.start();
    } catch {
      this.cleanup();
      throw new Error('denied' satisfies MicError);
    }
    this.meter();
    this.autoStop = window.setTimeout(() => {
      if (this.active) this.opts.onAutoStop?.();
    }, maxMs);
    return true;
  }

  stop(): Promise<Recording | null> {
    return new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === 'inactive') {
        this.cleanup();
        resolve(null);
        return;
      }
      this.finish = resolve;
      this.recorder.stop();
    });
  }

  cancel() {
    this.cancelled = true;
    this.discard = true;
    void this.stop();
  }

  private createContext() {
    if (!this.opts.onLevel && !this.opts.autoEnd) return;
    try {
      const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (AC) this.ctx = new AC();
      void this.ctx?.resume().catch(() => {});
    } catch {
      this.ctx = undefined;
    }
  }

  private meter() {
    if (!this.stream || !this.ctx) return;
    try {
      const source = this.ctx.createMediaStreamSource(this.stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buffer = new Uint8Array(analyser.fftSize);
      let last = performance.now();
      // A timer rather than animation frames: frames pause when the screen dims, the gate must not.
      this.tick = window.setInterval(() => {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const value of buffer) {
          const centered = (value - 128) / 128;
          sum += centered * centered;
        }
        const level = Math.min(1, Math.sqrt(sum / buffer.length) * 4);
        this.opts.onLevel?.(level);
        const now = performance.now();
        const event = this.gate?.feed(level, now - last) ?? 'none';
        last = now;
        if (event === 'end' && this.active) this.opts.onAutoStop?.();
        if (event === 'nothing' && this.active) {
          this.noSpeech = true;
          this.opts.onAutoStop?.();
        }
      }, 40);
    } catch {
      /* the meter is decoration; recording continues without it */
    }
  }

  private cleanup() {
    setAudioSession('playback');
    clearInterval(this.tick);
    clearTimeout(this.autoStop);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close().catch(() => {});
    this.ctx = undefined;
    this.opts.onLevel?.(0);
  }
}
