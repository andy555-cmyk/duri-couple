import { describe, expect, it } from 'vitest';
import { answerText, buildBody, callGemini, classify, GeminiError, MODELS, orderedModels, parseJsonLoose } from '../src/lib/gemini';

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

describe('model order', () => {
  it('puts the last good model first and cooling ones last', () => {
    const now = 1_000_000;
    const order = orderedModels(now, {
      [MODELS[0].id]: { skipUntil: now + 5000 },
      [MODELS[2].id]: { okAt: now - 10 },
    });
    expect(order[0].id).toBe(MODELS[2].id);
    expect(order[order.length - 1].id).toBe(MODELS[0].id);
  });
});
