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
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) });
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
  it('sends the couple setup with transcriptions, marking turns itself', () => {
    const { ws } = session();
    ws().open();
    const setup = ws().sent[0].setup;
    expect(ws().url).toContain('BidiGenerateContent?key=K');
    expect(setup.model).toBe('models/gemini-3.8-live');
    expect(setup.systemInstruction.parts[0].text).toBe('SYS');
    expect(setup.realtimeInputConfig.automaticActivityDetection).toEqual({ disabled: true });
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
    vi.advanceTimersByTime(1);
    expect(FakeWS.all).toHaveLength(2);
  });
  it('gives up on a socket that opens but never finishes setup, then tries the next model', () => {
    const { ws, events } = session();
    ws().open();
    vi.advanceTimersByTime(10_000);
    expect(FakeWS.all).toHaveLength(2);
    ws().open();
    vi.advanceTimersByTime(10_000);
    expect(FakeWS.all).toHaveLength(2);
    expect(events).toContainEqual(['state', 'error', 'busy']);
  });
  it('stops reconnecting after four drops, even though each reconnect finishes setup', () => {
    const { ws, events } = session();
    ws().open();
    ws().emit({ setupComplete: {} });
    for (let i = 0; i < 4; i++) {
      ws().close(1006, '');
      vi.advanceTimersByTime(2000);
      ws().open();
      ws().emit({ setupComplete: {} });
    }
    expect(FakeWS.all).toHaveLength(5);
    ws().close(1006, '');
    expect(events).toContainEqual(['state', 'error', 'network']);
    vi.advanceTimersByTime(10_000);
    expect(FakeWS.all).toHaveLength(5);
  });
  it('a finished exchange earns the reconnect budget back', () => {
    const { live, ws } = session();
    ws().open();
    ws().emit({ setupComplete: {} });
    ws().close(1006, '');
    vi.advanceTimersByTime(1000);
    ws().open();
    ws().emit({ setupComplete: {} });
    expect((live as any).reconnects).toBe(1);
    ws().emit({ serverContent: { inputTranscription: { text: '응' }, outputTranscription: { text: 'うん' }, turnComplete: true } });
    expect((live as any).reconnects).toBe(0);
  });
  it('drops half a sentence when the line breaks instead of gluing it to the next one', () => {
    const { ws, events } = session();
    ws().open();
    ws().emit({ setupComplete: {} });
    ws().emit({ serverContent: { inputTranscription: { text: '오늘 ' } } });
    ws().close(1006, '');
    expect(events[events.length - 1]).toEqual(['caption', '', '']);
    vi.advanceTimersByTime(1000);
    ws().open();
    ws().emit({ setupComplete: {} });
    ws().emit({ serverContent: { inputTranscription: { text: '고마워' }, outputTranscription: { text: 'ありがとう' }, turnComplete: true } });
    expect(events).toContainEqual(['turn', '고마워', 'ありがとう', 'gemini-3.8-live']);
  });
  it('stop cancels a pending reconnect', () => {
    const { live, ws } = session();
    ws().open();
    ws().emit({ setupComplete: {} });
    ws().close(1006, '');
    void live.stop();
    vi.advanceTimersByTime(5000);
    expect(FakeWS.all).toHaveLength(1);
  });
  const chunk = (value: number) => new Int16Array(1600).fill(value).buffer;
  const kinds = (ws: FakeWS) => ws.sent.map((m) => (m.realtimeInput?.activityStart ? 'start' : m.realtimeInput?.activityEnd ? 'end' : m.realtimeInput?.audio ? 'audio' : 'other'));
  it('marks the start and end of each utterance itself, with the moment before it', () => {
    const { live, ws } = session();
    ws().open();
    ws().emit({ setupComplete: {} });
    for (let i = 0; i < 5; i++) live.feed(chunk(0), 0.002); // quiet: nothing is sent
    expect(kinds(ws()).filter((k) => k !== 'other')).toEqual([]);
    live.feed(chunk(3000), 0.1);
    live.feed(chunk(3000), 0.1); // 0.2 s of voice: a turn starts, with up to 0.4 s from before
    expect(kinds(ws()).slice(1)).toEqual(['start', 'audio', 'audio', 'audio', 'audio']);
    for (let i = 0; i < 6; i++) live.feed(chunk(0), 0.002);
    expect(kinds(ws()).at(-1)).toBe('audio');
    live.feed(chunk(0), 0.002); // 0.7 s of quiet ends it
    expect(kinds(ws()).at(-1)).toBe('end');
    // The next utterance is a new turn.
    live.feed(chunk(3000), 0.1);
    live.feed(chunk(3000), 0.1);
    expect(kinds(ws()).filter((k) => k === 'start')).toHaveLength(2);
  });
  it('does not take its own translated voice for someone talking', () => {
    const { live, ws } = session();
    ws().open();
    ws().emit({ setupComplete: {} });
    (live as any).speak = true;
    (live as any).quietUntil = performance.now() + 5000;
    for (let i = 0; i < 6; i++) live.feed(chunk(3000), 0.1);
    expect(kinds(ws())).not.toContain('start');
  });
  it('ends a turn that runs on and on so it still gets translated', () => {
    const { live, ws } = session();
    ws().open();
    ws().emit({ setupComplete: {} });
    for (let i = 0; i < 205; i++) live.feed(chunk(3000), 0.1);
    expect(kinds(ws())).toContain('end');
  });
  it('starts a fresh turn after a reconnect instead of continuing a lost one', () => {
    const { live, ws } = session();
    ws().open();
    ws().emit({ setupComplete: {} });
    live.feed(chunk(3000), 0.1);
    live.feed(chunk(3000), 0.1);
    ws().close(1006, '');
    vi.advanceTimersByTime(1000);
    ws().open();
    ws().emit({ setupComplete: {} });
    live.feed(chunk(3000), 0.1);
    expect(kinds(ws())).not.toContain('start');
    live.feed(chunk(3000), 0.1);
    expect(kinds(ws()).slice(1, 2)).toEqual(['start']);
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
    expect(turnFromLive('오늘 고마웠어', '今日はありがとう', meta)).toMatchObject({ lang: 'ko', ko: '오늘 고마웠어', ja: '今日はありがとう', koKana: 'オヌㇽ コマウォッソ', jaHangul: '' });
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
