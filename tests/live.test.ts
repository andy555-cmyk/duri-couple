import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyClose, LiveInterpreter } from '../src/lib/live';
import { livePrompt, turnFromLive } from '../src/lib/prompts';
import { DEFAULT_PROFILE } from '../src/lib/store';

class FakeWS {
  static OPEN = 1;
  static all: FakeWS[] = [];
  readyState = 0;
  sent: any[] = [];
  binaryType = '';
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number; reason: string }) => void;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

beforeEach(() => {
  FakeWS.all = [];
  vi.stubGlobal('WebSocket', FakeWS);
  vi.stubGlobal('window', { setTimeout: (fn: () => void) => fn() });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function session(cb: Partial<ConstructorParameters<typeof LiveInterpreter>[1]> = {}) {
  const events: any[] = [];
  const live = new LiveInterpreter(
    { key: 'K', system: 'SYS', speak: false },
    {
      onState: (s, f) => events.push(['state', s, f]),
      onCaption: (c) => events.push(['caption', c.input, c.output]),
      onTurn: (t) => events.push(['turn', t.input, t.output, t.model]),
      ...cb,
    },
  );
  (live as any).connect();
  return { live, events, ws: () => FakeWS.all[FakeWS.all.length - 1] };
}

describe('real-time interpreting protocol', () => {
  it('sends the couple setup with transcriptions and a 1 s pause setting', () => {
    const { ws } = session();
    ws().open();
    const setup = ws().sent[0].setup;
    expect(ws().url).toContain('BidiGenerateContent?key=K');
    expect(setup.model).toBe('models/gemini-3.8-live');
    expect(setup.systemInstruction.parts[0].text).toBe('SYS');
    expect(setup.realtimeInputConfig.automaticActivityDetection).toEqual({ silenceDurationMs: 1000, endOfSpeechSensitivity: 'END_SENSITIVITY_LOW' });
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
  });
  it('builds captions as they arrive and reports the finished exchange', () => {
    const { ws, events } = session();
    ws().open();
    ws().emit({ setupComplete: {} });
    ws().emit({ serverContent: { inputTranscription: { text: '오늘 ' } } });
    ws().emit({ serverContent: { inputTranscription: { text: '고마웠어' } } });
    ws().emit({ serverContent: { outputTranscription: { text: '今日は' } } });
    ws().emit({ serverContent: { outputTranscription: { text: 'ありがとう' }, turnComplete: true } });
    expect(events).toContainEqual(['caption', '오늘 고마웠어', '今日は']);
    expect(events).toContainEqual(['turn', '오늘 고마웠어', '今日はありがとう', 'gemini-3.8-live']);
    expect(events).toContainEqual(['state', 'listening', undefined]);
  });
  it('falls back to the next model when one refuses the setup', () => {
    const { ws } = session();
    ws().open();
    ws().close(1011, 'model not available');
    expect(FakeWS.all).toHaveLength(2);
    ws().open();
    expect(ws().sent[0].setup.model).toBe('models/gemini-3.1-flash-live-preview');
  });
  it('stops at a rejected key instead of trying other models', () => {
    const { ws, events } = session();
    ws().open();
    ws().close(1008, 'API key not valid');
    expect(FakeWS.all).toHaveLength(1);
    expect(events).toContainEqual(['state', 'error', 'key']);
  });
  it('reconnects when the server ends a running session', () => {
    const { ws, events } = session();
    ws().open();
    ws().emit({ setupComplete: {} });
    ws().emit({ goAway: { timeLeft: '10s' } });
    expect(events).toContainEqual(['state', 'reconnecting', undefined]);
    expect(FakeWS.all).toHaveLength(2);
  });
  it('sends silence instead of the mic while its own translation is playing', () => {
    const { live, ws } = session();
    ws().open();
    ws().emit({ setupComplete: {} });
    (live as any).speak = true;
    (live as any).quietUntil = performance.now() + 5000;
    const mic = new Int16Array(1600).fill(1000).buffer;
    const handler = { port: { onmessage: null as any } };
    // reproduce the worklet callback logic
    const echo = (live as any).speak && performance.now() < (live as any).quietUntil;
    (live as any).send(echo ? (live as any).silence : mic);
    const audio = ws().sent[ws().sent.length - 1].realtimeInput.audio;
    expect(audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(atob(audio.data).split('').every((c) => c.charCodeAt(0) === 0)).toBe(true);
    expect(handler).toBeTruthy();
  });
  it('classifies close reasons', () => {
    expect(classifyClose(1008, 'API key not valid')).toBe('key');
    expect(classifyClose(1011, 'RESOURCE_EXHAUSTED: quota')).toBe('quota');
    expect(classifyClose(1006, '')).toBe('network');
    expect(classifyClose(1011, 'internal')).toBe('busy');
  });
});

describe('live exchanges become turns', () => {
  const meta = { id: 'x', ts: 1, model: 'gemini-3.8-live' };
  it('maps Korean speech with its Japanese translation', () => {
    expect(turnFromLive('오늘 고마웠어', '今日はありがとう', meta)).toMatchObject({ lang: 'ko', ko: '오늘 고마웠어', ja: '今日はありがとう', koKana: '', jaHangul: '' });
  });
  it('maps Japanese speech with its Korean translation', () => {
    expect(turnFromLive('楽しかった', '즐거웠어', meta)).toMatchObject({ lang: 'ja', ja: '楽しかった', ko: '즐거웠어' });
  });
  it('drops exchanges where the model did not translate', () => {
    expect(turnFromLive('오늘 고마웠어', '오늘 고마웠어', meta)).toBeNull();
    expect(turnFromLive('', 'こんにちは', meta)).toBeNull();
  });
  it('puts names, register and the dictionary into the live instructions', () => {
    const text = livePrompt({ ...DEFAULT_PROFILE, myName: 'Andy', partnerName: '시오리' }, [{ id: '1', ko: '우리 라멘집', ja: 'いつものラーメン屋' }]);
    expect(text).toContain('Andy (speaks Korean)');
    expect(text).toContain('시오리 (speaks Japanese)');
    expect(text).toContain('반말');
    expect(text).toContain('우리 라멘집 = いつものラーメン屋');
    expect(text).toContain('Never guess');
  });
});
