export interface Recording {
  blob: Blob;
  mime: string;
  ms: number;
}

export type MicError = 'unsupported' | 'denied' | 'short';

const MIME_PREFERENCE = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

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
 * One recording at a time. No timeslice: Safari then hands back a single, ordinary MP4
 * that Gemini decodes reliably. The level meter is optional and never blocks recording.
 */
export class Recorder {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private ctx?: AudioContext;
  private raf = 0;
  private autoStop = 0;
  private started = 0;
  private finish?: (r: Recording | null) => void;
  private discard = false;

  constructor(
    private onLevel?: (level: number) => void,
    private onAutoStop?: () => void,
  ) {}

  get active() {
    return !!this.recorder && this.recorder.state === 'recording';
  }

  async start(maxMs = 60000) {
    if (!micSupported()) throw new Error('unsupported' satisfies MicError);
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
    const mime = pickMime();
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.discard = false;
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) this.chunks.push(event.data);
    };
    this.recorder.onstop = () => {
      const type = this.recorder?.mimeType || mime || 'audio/mp4';
      const blob = new Blob(this.chunks, { type });
      const ms = Date.now() - this.started;
      this.cleanup();
      this.finish?.(this.discard ? null : { blob, mime: type.split(';')[0] || 'audio/mp4', ms });
      this.finish = undefined;
    };
    this.started = Date.now();
    this.recorder.start();
    this.meter();
    this.autoStop = window.setTimeout(() => {
      if (this.active) this.onAutoStop?.();
    }, maxMs);
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
    this.discard = true;
    void this.stop();
  }

  private createContext() {
    if (!this.onLevel) return;
    try {
      const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (AC) this.ctx = new AC();
      void this.ctx?.resume().catch(() => {});
    } catch {
      this.ctx = undefined;
    }
  }

  private meter() {
    if (!this.onLevel || !this.stream || !this.ctx) return;
    try {
      const source = this.ctx.createMediaStreamSource(this.stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buffer = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const value of buffer) {
          const centered = (value - 128) / 128;
          sum += centered * centered;
        }
        this.onLevel?.(Math.min(1, Math.sqrt(sum / buffer.length) * 4));
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* the meter is decoration; recording continues without it */
    }
  }

  private cleanup() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.autoStop);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close().catch(() => {});
    this.ctx = undefined;
    this.onLevel?.(0);
  }
}
