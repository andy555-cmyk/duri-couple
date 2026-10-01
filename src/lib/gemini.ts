/**
 * Gemini REST client with model fallback.
 *
 * Why it looks like this (measured on 2026-10-02 against ai.google.dev docs):
 * - Gemini 3.x always thinks, and maxOutputTokens is a hard cap on thinking + answer together.
 *   The old app capped at 600 tokens, so answers were cut off or empty. We cap at 4096 and
 *   ask for the lowest thinking level each model supports.
 * - gemini-2.5-flash is now restricted to prior users, so it is not in the chain.
 * - responseJsonSchema / thinkingConfig are newer fields; if a model rejects them we retry the
 *   same model with a plain JSON request and remember that ("lite") for next time.
 */

import { mockFetch } from './mock';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export interface ModelSpec {
  id: string;
  thinking: ThinkingLevel;
}

// Order from a real head-to-head on 2026-10-02 (tools/compare-models.mjs): 3.5-flash was the only model
// that was both available and correct on every task; 3.8/3.7/latest were often 503 on the free tier;
// minimal thinking (3.6) and flash-lite wrote replies in the wrong language, so lite is last resort.
export const MODELS: ModelSpec[] = [
  { id: 'gemini-3.5-flash', thinking: 'low' },
  { id: 'gemini-3.8-flash', thinking: 'low' },
  { id: 'gemini-3.6-flash', thinking: 'low' },
  { id: 'gemini-flash-latest', thinking: 'low' },
  { id: 'gemini-3.7-flash', thinking: 'low' },
  { id: 'gemini-3.5-flash-lite', thinking: 'minimal' },
];

export type ErrorKind =
  | 'nokey'
  | 'key'
  | 'quota'
  | 'busy'
  | 'timeout'
  | 'network'
  | 'format'
  | 'blocked'
  | 'model'
  | 'request'
  | 'silence'
  | 'aborted';

export class GeminiError extends Error {
  constructor(
    public kind: ErrorKind,
    public status = 0,
    public detail = '',
  ) {
    super(`${kind}${status ? ` ${status}` : ''}${detail ? `: ${detail}` : ''}`);
  }
}

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

interface Health {
  okAt?: number;
  ms?: number;
  skipUntil?: number;
  reason?: string;
  lite?: boolean;
}

export interface LogEntry {
  at: number;
  model: string;
  result: string;
  ms: number;
}

const HEALTH_KEY = 'duri.models';
const log: LogEntry[] = [];

function readHealth(): Record<string, Health> {
  try {
    return JSON.parse(localStorage.getItem(HEALTH_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeHealth(health: Record<string, Health>) {
  try {
    localStorage.setItem(HEALTH_KEY, JSON.stringify(health));
  } catch {
    /* storage full or blocked: health is only an optimisation */
  }
}

function note(model: string, patch: Health) {
  const health = readHealth();
  health[model] = { ...health[model], ...patch };
  writeHealth(health);
}

function record(model: string, result: string, ms: number) {
  log.unshift({ at: Date.now(), model, result, ms });
  log.length = Math.min(log.length, 30);
}

export const recentLog = () => log.slice();
export const modelHealth = () => readHealth();

/** Healthy models first, the last one that worked at the very front, cooling-down ones last. */
export function orderedModels(now = Date.now(), health = readHealth()): ModelSpec[] {
  const cooling = (m: ModelSpec) => (health[m.id]?.skipUntil || 0) > now;
  const score = (m: ModelSpec) => (cooling(m) ? 3 : 1);
  const lastGood = MODELS.filter((m) => health[m.id]?.okAt && !cooling(m)).sort(
    (a, b) => (health[b.id].okAt || 0) - (health[a.id].okAt || 0),
  )[0];
  return [...MODELS].sort((a, b) => {
    if (lastGood && a.id === lastGood.id) return -1;
    if (lastGood && b.id === lastGood.id) return 1;
    return score(a) - score(b);
  });
}

export function buildBody(opts: {
  system: string;
  parts: Part[];
  schema?: object;
  spec: ModelSpec;
  lite: boolean;
  maxTokens: number;
  temperature: number;
}) {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    temperature: opts.temperature,
    maxOutputTokens: opts.maxTokens,
  };
  if (!opts.lite) {
    if (opts.schema) generationConfig.responseJsonSchema = opts.schema;
    generationConfig.thinkingConfig = { thinkingLevel: opts.spec.thinking };
  }
  return {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: [{ role: 'user', parts: opts.parts }],
    generationConfig,
  };
}

/** Pulls the answer text out of a generateContent response, skipping thought parts. */
export function answerText(data: any): { text: string; finish: string; blocked: string } {
  const candidate = data?.candidates?.[0];
  const parts: any[] = candidate?.content?.parts || [];
  const text = parts
    .filter((p) => typeof p?.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  return {
    text,
    finish: candidate?.finishReason || '',
    blocked: data?.promptFeedback?.blockReason || '',
  };
}

export function parseJsonLoose(text: string): any {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(fenced);
  } catch {
    /* fall through */
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new SyntaxError('no json');
}

/** Decides what a failed HTTP response means and what to do next. */
export function classify(status: number, message: string): { kind: ErrorKind; action: 'stop' | 'next' | 'lite' } {
  const m = message.toLowerCase();
  if (status === 400 && (m.includes('api key') || m.includes('api_key'))) return { kind: 'key', action: 'stop' };
  if (status === 401) return { kind: 'key', action: 'stop' };
  if (status === 403) {
    if (m.includes('api key') || m.includes('api_key') || m.includes('service_disabled') || m.includes('has not been used'))
      return { kind: 'key', action: 'stop' };
    return { kind: 'model', action: 'next' };
  }
  if (status === 400 && (m.includes('unknown name') || m.includes('invalid json payload') || m.includes('thinking') || m.includes('schema')))
    return { kind: 'request', action: 'lite' };
  if (status === 404) return { kind: 'model', action: 'next' };
  if (status === 429) return { kind: 'quota', action: 'next' };
  if (status >= 500) return { kind: 'busy', action: 'next' };
  return { kind: 'request', action: 'next' };
}

const PRIORITY: ErrorKind[] = ['key', 'blocked', 'quota', 'busy', 'timeout', 'network', 'format', 'request', 'model'];

export interface CallResult<T> {
  data: T;
  model: string;
  ms: number;
  /** Set when no model passed validation and this is the best attempt we got. */
  invalid?: string;
  /** With `invalid`: the most telling reason the other models failed (e.g. quota). */
  failure?: ErrorKind;
}

/** Turns an unusable fallback answer into the error the person should see. */
export function failureOf(result: CallResult<unknown>) {
  return new GeminiError(result.failure === 'quota' || result.failure === 'busy' ? result.failure : 'format', 0, result.invalid || '');
}

export interface CallOptions<T> {
  key: string;
  system: string;
  parts: Part[];
  schema?: object;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  budgetMs?: number;
  /** Start the same request on the next model if the current one is this slow (0 = never). */
  hedgeMs?: number;
  /** Return a reason string when the answer is unusable (e.g. written in the wrong language). */
  validate?: (data: T) => string | null;
  models?: ModelSpec[];
  onModel?: (model: string) => void;
  fetchImpl?: typeof fetch;
}

type Outcome<T> = { ok: CallResult<T> } | { error: GeminiError; stop?: boolean; invalid?: CallResult<T> };

/** One model, including its own retries (plain request if new fields are rejected, bigger budget if cut off). */
async function runModel<T>(spec: ModelSpec, opts: CallOptions<T>, key: string, doFetch: typeof fetch, signal: AbortSignal, timeoutMs: number): Promise<Outcome<T>> {
  let lite = !!readHealth()[spec.id]?.lite;
  let maxTokens = opts.maxTokens ?? 4096;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) return { error: new GeminiError('aborted') };
    opts.onModel?.(spec.id);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const started = Date.now();
    try {
      const response = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${spec.id}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(
          buildBody({ system: opts.system, parts: opts.parts, schema: opts.schema, spec, lite, maxTokens, temperature: opts.temperature ?? 0.4 }),
        ),
        signal: controller.signal,
      });
      const ms = Date.now() - started;
      if (!response.ok) {
        let message = '';
        try {
          const body = await response.json();
          message = String(body?.error?.message || body?.error?.status || '');
        } catch {
          /* non-JSON error body */
        }
        const { kind, action } = classify(response.status, message);
        record(spec.id, `${response.status} ${message.slice(0, 90)}`, ms);
        const error = new GeminiError(kind, response.status, message.slice(0, 160));
        if (action === 'stop') return { error, stop: true };
        if (action === 'lite' && !lite) {
          lite = true;
          note(spec.id, { lite: true });
          continue;
        }
        const hardQuota = response.status === 429 && /limit:\s*0\b|free.?tier.*0/i.test(message);
        const cool = response.status === 404 || response.status === 403 || hardQuota ? 6 * 3600e3 : response.status === 429 ? 60e3 : 30e3;
        note(spec.id, { skipUntil: Date.now() + cool, reason: String(response.status) });
        return { error };
      }
      const raw = await response.json();
      const { text, finish, blocked } = answerText(raw);
      if (blocked || finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT') {
        record(spec.id, `blocked ${blocked || finish}`, ms);
        return { error: new GeminiError('blocked', 200, blocked || finish), stop: true };
      }
      let data: T;
      try {
        if (!text) throw new SyntaxError('empty');
        data = parseJsonLoose(text);
      } catch {
        record(spec.id, `${text ? 'bad json' : 'empty'} ${finish}`, ms);
        if (finish === 'MAX_TOKENS' && attempt === 0) {
          maxTokens *= 2;
          continue;
        }
        return { error: new GeminiError('format', 200, `${text ? 'bad json' : 'empty'} ${finish}`) };
      }
      const invalid = opts.validate?.(data) || null;
      if (invalid) {
        record(spec.id, `invalid ${invalid}`, ms);
        return { error: new GeminiError('format', 200, `invalid ${invalid}`), invalid: { data, model: spec.id, ms, invalid } };
      }
      record(spec.id, 'ok', ms);
      note(spec.id, { okAt: Date.now(), ms, skipUntil: 0, reason: '' });
      return { ok: { data, model: spec.id, ms } };
    } catch (caught) {
      const ms = Date.now() - started;
      if (signal.aborted && !timedOut) return { error: new GeminiError('aborted') };
      if (timedOut || (caught instanceof DOMException && caught.name === 'AbortError')) {
        record(spec.id, 'timeout', ms);
        note(spec.id, { skipUntil: Date.now() + 20e3, reason: 'timeout' });
        return { error: new GeminiError('timeout') };
      }
      record(spec.id, `network ${(caught as Error)?.message || ''}`.slice(0, 90), ms);
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      return { error: new GeminiError('network'), stop: offline };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
  return { error: new GeminiError('format', 200, 'retries exhausted') };
}

/**
 * Tries models in order. A failure moves straight on; a slow model gets company: after hedgeMs the
 * next model starts in parallel and the first usable answer wins (the rest are cancelled).
 */
export function callGemini<T = any>(opts: CallOptions<T>): Promise<CallResult<T>> {
  const key = opts.key.trim();
  if (!key) return Promise.reject(new GeminiError('nokey'));
  const doFetch = opts.fetchImpl || (import.meta.env.DEV && key === 'mock' ? mockFetch : fetch.bind(globalThis));
  const timeoutMs = opts.timeoutMs ?? 25000;
  const deadline = Date.now() + (opts.budgetMs ?? Math.max(45000, timeoutMs * 1.6));
  const hedgeMs = opts.hedgeMs ?? 0;
  const queue = [...(opts.models || orderedModels())];
  const errors: GeminiError[] = [];
  let fallback: CallResult<T> | null = null;
  const running = new Set<AbortController>();
  let settled = false;

  return new Promise<CallResult<T>>((resolve, reject) => {
    const finish = (result: CallResult<T> | null, error?: GeminiError) => {
      if (settled) return;
      settled = true;
      running.forEach((c) => c.abort());
      opts.signal?.removeEventListener('abort', onOuterAbort);
      if (result) resolve(result);
      else reject(error);
    };
    const giveUp = () => {
      errors.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
      if (fallback) return finish({ ...fallback, failure: errors[0]?.kind });
      finish(null, errors[0] || new GeminiError('model'));
    };
    const onOuterAbort = () => finish(null, new GeminiError('aborted'));
    if (opts.signal?.aborted) return onOuterAbort();
    opts.signal?.addEventListener('abort', onOuterAbort);

    const launch = () => {
      if (settled) return;
      const remaining = deadline - Date.now();
      const spec = queue.shift();
      if (!spec || remaining < 3000) {
        if (!running.size) giveUp();
        return;
      }
      const controller = new AbortController();
      running.add(controller);
      const hedge = hedgeMs > 0 ? setTimeout(() => running.has(controller) && running.size < 2 && launch(), hedgeMs) : 0;
      void runModel(spec, opts, key, doFetch, controller.signal, Math.max(3000, Math.min(timeoutMs, remaining))).then((outcome) => {
        clearTimeout(hedge);
        running.delete(controller);
        if (settled) return;
        if ('ok' in outcome) return finish(outcome.ok);
        if (outcome.error.kind === 'aborted') return;
        if (outcome.stop) return finish(null, outcome.error);
        errors.push(outcome.error);
        if (outcome.invalid) fallback ??= outcome.invalid;
        if (running.size === 0 || queue.length) launch();
        if (!running.size && !queue.length) giveUp();
      });
    };
    launch();
  });
}

/** Lightweight probe used by the "connection test" button and onboarding. */
export async function probeModel(key: string, spec: ModelSpec, fetchImpl?: typeof fetch) {
  const started = Date.now();
  try {
    const result = await callGemini<{ ok: boolean }>({
      key,
      system: 'Reply only with JSON.',
      parts: [{ text: 'Return {"ok": true}' }],
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      models: [spec],
      timeoutMs: 20000,
      maxTokens: 512,
      fetchImpl,
    });
    return { ok: true as const, ms: result.ms, detail: '' };
  } catch (caught) {
    const error = caught as GeminiError;
    return {
      ok: false as const,
      ms: Date.now() - started,
      kind: error.kind,
      status: error.status,
      detail: error.detail || error.kind,
    };
  }
}

/** Finds the first model that answers; used right after a key is entered. */
export async function quickCheck(key: string) {
  for (const spec of orderedModels()) {
    const result = await probeModel(key, spec);
    if (result.ok) return { model: spec.id, ms: result.ms };
    if (result.kind === 'key') throw new GeminiError('key', result.status, result.detail);
  }
  throw new GeminiError('model');
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}
