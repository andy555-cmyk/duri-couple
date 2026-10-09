import { describe, expect, it } from 'vitest';
import { answerText, buildBody, callGemini, callsLeft, classify, GeminiError, MODELS, orderedModels, parseJsonLoose, parseRetry, quotaWait } from '../src/lib/gemini';

const ok = (obj: unknown, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP', ...extra }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { code: status, message } }), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; body: any }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('request body', () => {
  it('sends schema, thinking level and a large token budget', () => {
    const body = buildBody({ system: 'S', parts: [{ text: 'hi' }], schema: { type: 'object' }, spec: MODELS[0], lite: false, maxTokens: 4096, temperature: 0.4 });
    expect(body.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object' },
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingLevel: 'low' },
    });
    expect(body.systemInstruction.parts[0].text).toBe('S');
  });
  it('lite mode drops the newer fields', () => {
    const body = buildBody({ system: 'S', parts: [], schema: { type: 'object' }, spec: MODELS[1], lite: true, maxTokens: 4096, temperature: 0.4 });
    expect(body.generationConfig).not.toHaveProperty('responseJsonSchema');
    expect(body.generationConfig).not.toHaveProperty('thinkingConfig');
  });
});

describe('response parsing', () => {
  it('ignores thought parts', () => {
    const data = { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"a":1}' }] }, finishReason: 'STOP' }] };
    expect(answerText(data).text).toBe('{"a":1}');
  });
  it('parses fenced or padded JSON', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Sure! {"a":2} done')).toEqual({ a: 2 });
    expect(() => parseJsonLoose('nope')).toThrow();
  });
});

describe('error classification', () => {
  it('stops on bad keys', () => {
    expect(classify(400, 'API key not valid. Please pass a valid API key.')).toEqual({ kind: 'key', action: 'stop' });
    expect(classify(401, '')).toEqual({ kind: 'key', action: 'stop' });
    expect(classify(403, 'Method doesn\'t allow unregistered callers (callers without established identity). Please use API Key')).toEqual({ kind: 'key', action: 'stop' });
  });
  it('moves on for model problems and overload', () => {
    expect(classify(404, 'models/x is not found')).toEqual({ kind: 'model', action: 'next' });
    expect(classify(403, 'This model is restricted to prior active users')).toEqual({ kind: 'model', action: 'next' });
    expect(classify(503, 'The model is overloaded.')).toEqual({ kind: 'busy', action: 'next' });
    expect(classify(429, 'Resource has been exhausted')).toEqual({ kind: 'quota', action: 'next' });
  });
  it('retries lite on unknown fields', () => {
    expect(classify(400, 'Invalid JSON payload received. Unknown name "responseJsonSchema"')).toEqual({ kind: 'request', action: 'lite' });
  });
});

describe('callGemini fallback', () => {
  const models = MODELS.slice(0, 3);
  it('falls through 503 and 404 to a working model', async () => {
    const { impl, calls } = fakeFetch([fail(503, 'overloaded'), fail(404, 'not found'), ok({ said: 'hi' })]);
    const result = await callGemini({ key: 'k', system: 's', parts: [{ text: 'x' }], models, fetchImpl: impl });
    expect(result.data).toEqual({ said: 'hi' });
    expect(result.model).toBe(models[2].id);
    expect(calls.map((c) => c.url.split('/models/')[1])).toEqual(models.map((m) => `${m.id}:generateContent`));
  });
  it('sends the key only as a header, never in the URL', async () => {
    const { impl, calls } = fakeFetch([ok({})]);
    await callGemini({ key: 'SECRET', system: 's', parts: [], models, fetchImpl: impl });
    expect(calls[0].url).not.toContain('SECRET');
  });
  it('stops immediately on a rejected key', async () => {
    const { impl, calls } = fakeFetch([fail(400, 'API key not valid')]);
    await expect(callGemini({ key: 'k', system: 's', parts: [], models, fetchImpl: impl })).rejects.toMatchObject({ kind: 'key' });
    expect(calls).toHaveLength(1);
  });
  it('retries the same model without new fields when they are rejected', async () => {
    const { impl, calls } = fakeFetch([fail(400, 'Invalid JSON payload received. Unknown name "thinkingLevel"'), ok({ ok: true })]);
    const result = await callGemini({ key: 'k', system: 's', parts: [], schema: { type: 'object' }, models, fetchImpl: impl });
    expect(result.model).toBe(models[0].id);
    expect(calls[1].body.generationConfig.thinkingConfig).toBeUndefined();
  });
  it('doubles the budget when the answer was cut off', async () => {
    const cut = new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"said": "hel' }] }, finishReason: 'MAX_TOKENS' }] }), { status: 200 });
    const { impl, calls } = fakeFetch([cut, ok({ said: 'hello' })]);
    const result = await callGemini({ key: 'k', system: 's', parts: [], models, maxTokens: 1000, fetchImpl: impl });
    expect(result.data).toEqual({ said: 'hello' });
    expect(calls[1].body.generationConfig.maxOutputTokens).toBe(2000);
  });
  it('reports the most useful error when everything fails', async () => {
    const { impl } = fakeFetch([fail(429, 'quota'), fail(503, 'busy'), fail(404, 'missing')]);
    await expect(callGemini({ key: 'k', system: 's', parts: [], models, fetchImpl: impl })).rejects.toMatchObject({ kind: 'quota' });
  });
  it('turns a safety block into a clear error', async () => {
    const blocked = new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 });
    const { impl } = fakeFetch([blocked]);
    await expect(callGemini({ key: 'k', system: 's', parts: [], models, fetchImpl: impl })).rejects.toBeInstanceOf(GeminiError);
  });
  it('needs a key', async () => {
    await expect(callGemini({ key: ' ', system: 's', parts: [] })).rejects.toMatchObject({ kind: 'nokey' });
  });
});

describe('validation', () => {
  const models = MODELS.slice(0, 3);
  it('moves to the next model when an answer fails validation', async () => {
    const { impl } = fakeFetch([ok({ lang: 'xx' }), ok({ lang: 'ja' })]);
    const result = await callGemini<{ lang: string }>({ key: 'k', system: 's', parts: [], models, fetchImpl: impl, validate: (d) => (d.lang === 'ja' ? null : 'lang') });
    expect(result.data.lang).toBe('ja');
    expect(result.model).toBe(models[1].id);
    expect(result.invalid).toBeUndefined();
  });
  it('returns the best invalid attempt rather than nothing', async () => {
    const { impl } = fakeFetch([ok({ lang: 'xx' }), fail(503, 'busy'), fail(503, 'busy')]);
    const result = await callGemini<{ lang: string }>({ key: 'k', system: 's', parts: [], models, fetchImpl: impl, validate: () => 'lang' });
    expect(result.invalid).toBe('lang');
    expect(result.model).toBe(models[0].id);
    expect(result.failure).toBe('busy');
  });
});

describe('hedging slow models', () => {
  const models = MODELS.slice(0, 3);
  /** Each entry answers after `delay` ms unless its request is cancelled first. */
  function timedFetch(entries: { delay: number; body: unknown }[]) {
    const aborted: string[] = [];
    const impl = ((url: string, init: RequestInit) => {
      const entry = entries.shift()!;
      const model = url.split('/models/')[1].split(':')[0];
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(ok(entry.body)), entry.delay);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          aborted.push(model);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;
    return { impl, aborted };
  }
  it('starts the next model when the first is slow, takes the first answer and cancels the other', async () => {
    const { impl, aborted } = timedFetch([
      { delay: 400, body: { from: 'slow' } },
      { delay: 20, body: { from: 'fast' } },
    ]);
    const result = await callGemini<{ from: string }>({ key: 'k', system: 's', parts: [], models, hedgeMs: 50, fetchImpl: impl });
    expect(result.data.from).toBe('fast');
    expect(result.model).toBe(models[1].id);
    expect(aborted).toEqual([models[0].id]);
  });
  it('does not hedge when the first model is quick', async () => {
    const { impl } = timedFetch([{ delay: 10, body: { from: 'first' } }]);
    const result = await callGemini<{ from: string }>({ key: 'k', system: 's', parts: [], models, hedgeMs: 200, fetchImpl: impl });
    expect(result.model).toBe(models[0].id);
  });
  it('a quick failure does not start a third model while the second is still working', async () => {
    const asked: string[] = [];
    const impl = ((url: string, init: RequestInit) => {
      const model = url.split('/models/')[1].split(':')[0];
      asked.push(model);
      const [delay, response] = model === models[0].id ? [100, () => fail(503, 'overloaded')] : [300, () => ok({ from: model })];
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(response()), delay);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;
    const result = await callGemini<{ from: string }>({ key: 'k', system: 's', parts: [], models, hedgeMs: 50, fetchImpl: impl });
    expect(result.model).toBe(models[1].id);
    expect(asked).toEqual([models[0].id, models[1].id]);
  });
  it('can be cancelled by the caller', async () => {
    const { impl } = timedFetch([{ delay: 500, body: {} }]);
    const controller = new AbortController();
    const pending = callGemini({ key: 'k', system: 's', parts: [], models, fetchImpl: impl, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });
});

describe('model order and pacing', () => {
  it('keeps quality order and moves cooling or used-up models to the back', () => {
    const now = 1_000_000;
    const order = orderedModels(now, { [MODELS[0].id]: { skipUntil: now + 5000 } }, {});
    expect(order[0].id).toBe(MODELS[1].id);
    expect(order[order.length - 1].id).toBe(MODELS[0].id);
  });
  it('switches model before hitting the per-minute limit', () => {
    const now = 1_000_000;
    const used = Array.from({ length: MODELS[0].perMinute }, (_, i) => now - 1000 * (i + 1));
    const order = orderedModels(now, {}, { [MODELS[0].id]: used });
    expect(order[0].id).toBe(MODELS[1].id);
    expect(callsLeft(now, { [MODELS[0].id]: used })[MODELS[0].id]).toBe(0);
  });
  it('waits instead of asking again when every model is resting after a 429', () => {
    const now = 1_000_000;
    const resting = (reason: string, ms: number) => ({ skipUntil: now + ms, reason });
    const all429 = Object.fromEntries(MODELS.map((m, i) => [m.id, resting('429', 20_000 + i * 1000)]));
    expect(quotaWait(now, all429)).toBe(20_000);
    // A model resting for another reason first: just try it.
    expect(quotaWait(now, { ...all429, [MODELS[3].id]: resting('timeout', 5_000) })).toBe(0);
    // One model free: no waiting.
    const { [MODELS[2].id]: _free, ...rest } = all429;
    expect(quotaWait(now, rest)).toBe(0);
  });
  it('reads Google\'s retry delay and daily limits from a 429', () => {
    const body = {
      error: {
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '5' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '23s' },
        ],
      },
    };
    expect(parseRetry(body)).toEqual({ delayMs: 23000, daily: false, limit: 'GenerateRequestsPerMinutePerProjectPerModel 5' });
    expect(parseRetry({ error: { details: [{ '@type': 'x.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }).daily).toBe(true);
  });
});

describe('streaming', () => {
  const models = MODELS.slice(0, 3);
  function sse(json: string, opts: { pieces?: number; firstDelay?: number; gap?: number } = {}) {
    const n = opts.pieces ?? 5;
    const size = Math.ceil(json.length / n);
    const parts = Array.from({ length: n }, (_, i) => json.slice(i * size, (i + 1) * size)).filter(Boolean);
    const encoder = new TextEncoder();
    return (init: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const wait = (ms: number) =>
              new Promise<void>((resolve, reject) => {
                const t = setTimeout(resolve, ms);
                init.signal?.addEventListener('abort', () => {
                  clearTimeout(t);
                  reject(new DOMException('aborted', 'AbortError'));
                });
              });
            try {
              await wait(opts.firstDelay ?? 0);
              for (let i = 0; i < parts.length; i++) {
                const last = i === parts.length - 1;
                const event = { candidates: [{ content: { parts: [{ text: parts[i] }] }, ...(last ? { finishReason: 'STOP' } : {}) }] };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`));
                await wait(opts.gap ?? 1);
              }
              controller.close();
            } catch (e) {
              controller.error(e);
            }
          },
        }),
        { status: 200 },
      );
  }
  function streamFetch(makers: ((init: RequestInit) => Response)[]) {
    const urls: string[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      urls.push(url);
      return makers.shift()!(init);
    }) as unknown as typeof fetch;
    return { impl, urls };
  }
  it('shows words as they arrive and returns the whole answer', async () => {
    const json = JSON.stringify({ said: '보고 싶어', translation: '会いたい', koKana: 'ポゴ シポ' });
    const { impl, urls } = streamFetch([sse(json, { pieces: 30 })]);
    const seen: string[] = [];
    const result = await callGemini<any>({ key: 'k', system: 's', parts: [], models, fetchImpl: impl, onPartial: (p) => seen.push(String(p.value.translation ?? '')) });
    expect(urls[0]).toContain(':streamGenerateContent?alt=sse');
    expect(result.data).toEqual({ said: '보고 싶어', translation: '会いたい', koKana: 'ポゴ シポ' });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.some((t) => t && t !== '会いたい')).toBe(true);
    expect(seen[seen.length - 1]).toBe('会いたい');
  });
  it('lets the first model to speak win when the first is slow to start', async () => {
    const slow = JSON.stringify({ from: 'slow' });
    const fast = JSON.stringify({ from: 'fast' });
    const { impl } = streamFetch([sse(slow, { firstDelay: 400 }), sse(fast, { firstDelay: 10 })]);
    const shownFrom = new Set<string>();
    const result = await callGemini<any>({ key: 'k', system: 's', parts: [], models, hedgeMs: 50, fetchImpl: impl, onPartial: (_p, model) => shownFrom.add(model) });
    expect(result.data.from).toBe('fast');
    expect([...shownFrom]).toEqual([models[1].id]);
  });
  it('clears the screen and moves on when a streamed answer turns out unusable', async () => {
    const bad = JSON.stringify({ lang: 'xx' });
    const good = JSON.stringify({ lang: 'ja' });
    const { impl } = streamFetch([sse(bad), sse(good)]);
    let resets = 0;
    const result = await callGemini<any>({
      key: 'k',
      system: 's',
      parts: [],
      models,
      fetchImpl: impl,
      onPartial: () => {},
      onReset: () => resets++,
      validate: (d) => (d.lang === 'ja' ? null : 'lang'),
    });
    expect(result.data.lang).toBe('ja');
    expect(resets).toBe(1);
  });
});
