/**
 * Gemini REST client: streaming, model fallback, per-model pacing.
 *
 * What the real API showed (2026-10-02 and 2026-10-09, tools/bench.mjs):
 * - A normal translation is 2.0–2.6 s end to end with 0 thinking tokens; the cost is ~250 output tokens.
 *   Streaming shows the first words after ~1 s and a finished translation after ~1.0–1.5 s.
 * - The free tier allows only ~6–7 calls per minute per flash model (flash-lite allows more). Hitting it
 *   used to push the app onto 3.8/3.7-flash, which answer "overloaded" (503) only after 4–9 s —
 *   that was the sudden slowness. So we count our own calls per model and switch before the limit,
 *   keep the overloaded models last, and cool them down for minutes, not seconds.
 * - maxOutputTokens caps thinking + answer together (4096 here); responseJsonSchema/thinkingConfig may be
 *   rejected by some models, in which case we retry that model with a plain JSON request ("lite").
 */

import { mockFetch } from './mock';
import { parsePartial, type Partial } from './partial';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export interface ModelSpec {
  id: string;
  thinking: ThinkingLevel;
  /** Our own soft limit per rolling minute, kept just under the measured free-tier limit. */
  perMinute: number;
}

// Quality first (tools/compare-models.mjs), then the generous fallbacks, the often-overloaded ones last.
export const MODELS: ModelSpec[] = [
  { id: 'gemini-3.5-flash', thinking: 'low', perMinute: 5 },
  { id: 'gemini-3.6-flash', thinking: 'low', perMinute: 6 },
  { id: 'gemini-3.5-flash-lite', thinking: 'minimal', perMinute: 12 },
  { id: 'gemini-flash-latest', thinking: 'low', perMinute: 5 },
  { id: 'gemini-3.8-flash', thinking: 'low', perMinute: 4 },
  { id: 'gemini-3.7-flash', thinking: 'low', perMinute: 4 },
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
  firstMs?: number;
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
const RATE_KEY = 'duri.rate';
const log: LogEntry[] = [];

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || '') ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: health and pacing are only optimisations */
  }
}

const readHealth = () => readJson<Record<string, Health>>(HEALTH_KEY, {});

function note(model: string, patch: Health) {
  const health = readHealth();
  health[model] = { ...health[model], ...patch };
  writeJson(HEALTH_KEY, health);
}

function record(model: string, result: string, ms: number) {
  log.unshift({ at: Date.now(), model, result, ms });
  log.length = Math.min(log.length, 40);
}

export const recentLog = () => log.slice();
export const modelHealth = () => readHealth();

/* ---------- pacing: count our own calls per model in the last minute ---------- */

function readRate(now = Date.now()): Record<string, number[]> {
  const rate = readJson<Record<string, number[]>>(RATE_KEY, {});
  for (const id of Object.keys(rate)) rate[id] = (rate[id] || []).filter((t) => now - t < 60_000);
  return rate;
}

function countCall(model: string, now = Date.now()) {
  const rate = readRate(now);
  rate[model] = [...(rate[model] || []), now];
  writeJson(RATE_KEY, rate);
}

/** Calls left this minute for each model (by our own soft limit). */
export function callsLeft(now = Date.now(), rate = readRate(now)): Record<string, number> {
  return Object.fromEntries(MODELS.map((m) => [m.id, Math.max(0, m.perMinute - (rate[m.id]?.length || 0))]));
}

/**
 * Usable models in quality order; models that are cooling down or out of calls this minute go last,
 * soonest-available first, so something is always tried.
 */
export function orderedModels(now = Date.now(), health = readHealth(), rate = readRate(now)): ModelSpec[] {
  const freeAt = (m: ModelSpec) => {
    const cool = health[m.id]?.skipUntil || 0;
    const calls = rate[m.id] || [];
    const paced = calls.length >= m.perMinute ? calls[calls.length - m.perMinute] + 60_000 : 0;
    return Math.max(cool, paced);
  };
  const ready = MODELS.filter((m) => freeAt(m) <= now);
  const waiting = MODELS.filter((m) => freeAt(m) > now).sort((a, b) => freeAt(a) - freeAt(b));
  return [...ready, ...waiting];
}

/** Models that are neither cooling down nor out of calls; if none, the one that frees up first. */
export function usableModels(now = Date.now(), health = readHealth(), rate = readRate(now)): ModelSpec[] {
  const left = callsLeft(now, rate);
  const ready = orderedModels(now, health, rate).filter((m) => (health[m.id]?.skipUntil || 0) <= now && left[m.id] > 0);
  return ready.length ? ready : orderedModels(now, health, rate).slice(0, 1);
}

/**
 * When every model is resting after Google answered "too many requests", how long until the first is
 * free again (ms); 0 when something can be tried. Asking again early only earns another 429
 * (Codex review2 M3).
 */
export function quotaWait(now = Date.now(), health = readHealth()): number {
  const rests = MODELS.map((m) => health[m.id]).filter((h) => (h?.skipUntil || 0) > now);
  if (rests.length < MODELS.length) return 0;
  const soonest = rests.reduce((a, b) => ((a!.skipUntil || 0) <= (b!.skipUntil || 0) ? a : b))!;
  return soonest.reason === '429' ? (soonest.skipUntil || 0) - now : 0;
}

export function buildBody(opts: {
  system: string;
  parts: Part[];
  schema?: object;
  spec: Pick<ModelSpec, 'id' | 'thinking'>;
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

/** Pulls the answer text out of a generateContent response (or one streamed chunk), skipping thought parts. */
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

/** How long Google asked us to wait after a 429, and whether it was a daily limit. */
export function parseRetry(body: any): { delayMs: number; daily: boolean; limit: string } {
  const details: any[] = body?.error?.details || [];
  let delayMs = 0;
  let daily = false;
  let limit = '';
  for (const d of details) {
    const type = String(d?.['@type'] || '');
    if (type.includes('RetryInfo')) {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d.retryDelay || ''));
      if (m) delayMs = Math.ceil(Number(m[1]) * 1000);
    }
    if (type.includes('QuotaFailure')) {
      for (const v of d.violations || []) {
        const id = String(v?.quotaId || '');
        if (/PerDay/i.test(id)) daily = true;
        if (!limit) limit = `${id.replace(/-FreeTier$/i, '')} ${v?.quotaValue ?? ''}`.trim();
      }
    }
  }
  return { delayMs, daily, limit };
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
  /**
   * Start the same request on the next model if the current one is this slow (0 = never).
   * When streaming, "slow" means no first words yet.
   */
  hedgeMs?: number;
  /** Most models one action may try (default 3). */
  maxModels?: number;
  /** Return a reason string when the answer is unusable (e.g. written in the wrong language). */
  validate?: (data: T) => string | null;
  /** Stream the answer and report what has arrived so far. */
  onPartial?: (partial: Partial<T>, model: string) => void;
  /** The streamed answer being shown was abandoned (that model failed); clear it. */
  onReset?: () => void;
  models?: ModelSpec[];
  onModel?: (model: string) => void;
  fetchImpl?: typeof fetch;
}

type Outcome<T> = { ok: CallResult<T> } | { error: GeminiError; stop?: boolean; invalid?: CallResult<T> };

/** Reads a server-sent-events body and calls onText for each answer chunk. */
async function readSse(body: ReadableStream<Uint8Array>, onChunk: (data: any) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (data) onChunk(JSON.parse(data));
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith('data:')) onChunk(JSON.parse(rest.slice(5).trim()));
}

/** One model, including its own retries (plain request if new fields are rejected, bigger budget if cut off). */
async function runModel<T>(
  spec: ModelSpec,
  opts: CallOptions<T>,
  key: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
  timeoutMs: number,
  deadline: number,
  onFirst: () => void,
): Promise<Outcome<T>> {
  let lite = !!readHealth()[spec.id]?.lite;
  let maxTokens = opts.maxTokens ?? 4096;
  const stream = !!opts.onPartial;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) return { error: new GeminiError('aborted') };
    opts.onModel?.(spec.id);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort);
    // Retries inside one model share the overall deadline too (Codex review S2).
    const remaining = deadline - Date.now();
    if (remaining < 1000) {
      signal.removeEventListener('abort', onAbort);
      return { error: new GeminiError('timeout') };
    }
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.min(timeoutMs, remaining),
    );
    const started = Date.now();
    countCall(spec.id);
    try {
      const response = await doFetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${spec.id}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(
            buildBody({ system: opts.system, parts: opts.parts, schema: opts.schema, spec, lite, maxTokens, temperature: opts.temperature ?? 0.4 }),
          ),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const ms = Date.now() - started;
        let body: any = null;
        try {
          body = await response.json();
        } catch {
          /* non-JSON error body */
        }
        const message = String(body?.error?.message || body?.error?.status || '');
        const { kind, action } = classify(response.status, message);
        const retry = response.status === 429 ? parseRetry(body) : null;
        record(spec.id, `${response.status} ${retry?.limit ? `[${retry.limit}] ` : ''}${message.slice(0, 80)}`, ms);
        const error = new GeminiError(kind, response.status, message.slice(0, 160));
        if (action === 'stop') return { error, stop: true };
        if (action === 'lite' && !lite) {
          lite = true;
          note(spec.id, { lite: true });
          continue;
        }
        const hardQuota = response.status === 429 && (retry?.daily || /limit:\s*0\b/i.test(message));
        const cool =
          response.status === 404 || response.status === 403 || hardQuota
            ? 6 * 3600e3
            : response.status === 429
              ? Math.max(retry?.delayMs || 0, 20e3)
              : response.status === 503
                ? 5 * 60e3
                : 30e3;
        note(spec.id, { skipUntil: Date.now() + cool, reason: String(response.status) });
        return { error };
      }

      let text = '';
      let finish = '';
      let blocked = '';
      let firstMs = 0;
      if (stream && response.body) {
        await readSse(response.body, (chunk) => {
          const piece = answerText(chunk);
          if (piece.finish) finish = piece.finish;
          if (piece.blocked) blocked = piece.blocked;
          if (!piece.text) return;
          if (!firstMs) {
            firstMs = Date.now() - started;
            onFirst();
          }
          text += piece.text;
          if (!signal.aborted) opts.onPartial?.(parsePartial<T>(text), spec.id);
        });
      } else {
        const raw = await response.json();
        ({ text, finish, blocked } = answerText(raw));
        onFirst();
      }
      const ms = Date.now() - started;
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
          opts.onReset?.();
          continue;
        }
        return { error: new GeminiError('format', 200, `${text ? 'bad json' : 'empty'} ${finish}`) };
      }
      const invalid = opts.validate?.(data) || null;
      if (invalid) {
        record(spec.id, `invalid ${invalid}`, ms);
        return { error: new GeminiError('format', 200, `invalid ${invalid}`), invalid: { data, model: spec.id, ms, invalid } };
      }
      record(spec.id, firstMs ? `ok · first ${firstMs}ms` : 'ok', ms);
      note(spec.id, { okAt: Date.now(), ms, firstMs: firstMs || undefined, skipUntil: 0, reason: '' });
      return { ok: { data, model: spec.id, ms } };
    } catch (caught) {
      const ms = Date.now() - started;
      if (signal.aborted && !timedOut) return { error: new GeminiError('aborted') };
      if (timedOut || (caught instanceof DOMException && caught.name === 'AbortError')) {
        record(spec.id, 'timeout', ms);
        note(spec.id, { skipUntil: Date.now() + 60e3, reason: 'timeout' });
        return { error: new GeminiError('timeout') };
      }
      if (caught instanceof SyntaxError) {
        record(spec.id, 'bad stream', ms);
        return { error: new GeminiError('format', 200, 'bad stream') };
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
 * next model starts in parallel. The first one to produce words (streaming) or an answer wins and
 * the rest are cancelled, so only one stream ever feeds the screen.
 */
export function callGemini<T = any>(opts: CallOptions<T>): Promise<CallResult<T>> {
  const key = opts.key.trim();
  if (!key) return Promise.reject(new GeminiError('nokey'));
  const doFetch = opts.fetchImpl || (import.meta.env.DEV && key === 'mock' ? mockFetch : fetch.bind(globalThis));
  const timeoutMs = opts.timeoutMs ?? 25000;
  const deadline = Date.now() + (opts.budgetMs ?? Math.max(45000, timeoutMs * 1.6));
  const hedgeMs = opts.hedgeMs ?? 0;
  if (!opts.models) {
    const wait = quotaWait();
    if (wait > 0) return Promise.reject(new GeminiError('quota', 429, `all models resting for ${Math.ceil(wait / 1000)}s`));
  }
  // One tap never fans out over every model: only usable ones, at most maxModels (Codex review S1).
  const queue = (opts.models || usableModels()).slice(0, opts.maxModels ?? 3);
  let launched = 0;
  const errors: GeminiError[] = [];
  let fallback: CallResult<T> | null = null;
  const running = new Map<AbortController, string>();
  let leader: AbortController | null = null;
  let settled = false;

  return new Promise<CallResult<T>>((resolve, reject) => {
    const finish = (result: CallResult<T> | null, error?: GeminiError) => {
      if (settled) return;
      settled = true;
      running.forEach((_, c) => c.abort());
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
      running.set(controller, spec.id);
      // Only the first model gets company; later ones are plain fallbacks, so one tap costs at most
      // two calls unless both fail (Codex review2 H3).
      const hedge =
        hedgeMs > 0 && launched++ === 0 ? setTimeout(() => !leader && running.has(controller) && running.size < 2 && launch(), hedgeMs) : 0;
      const becomeLeader = () => {
        clearTimeout(hedge);
        if (leader) return;
        leader = controller;
        // Only one stream may draw on screen: cancel the others.
        running.forEach((_, other) => other !== controller && other.abort());
      };
      const filtered: CallOptions<T> = {
        ...opts,
        onPartial: opts.onPartial ? (p, model) => leader === controller && opts.onPartial!(p, model) : undefined,
      };
      void runModel(spec, filtered, key, doFetch, controller.signal, timeoutMs, deadline, becomeLeader).then((outcome) => {
        clearTimeout(hedge);
        running.delete(controller);
        if (settled) return;
        if ('ok' in outcome) return finish(outcome.ok);
        if (outcome.error.kind === 'aborted' && leader && leader !== controller) return;
        if (outcome.stop) return finish(null, outcome.error);
        if (outcome.error.kind !== 'aborted') errors.push(outcome.error);
        if (outcome.invalid) fallback ??= outcome.invalid;
        if (leader === controller) {
          leader = null;
          opts.onReset?.();
        }
        // The next model waits until nothing else is in flight; launch() gives up when the queue is empty.
        if (running.size === 0) launch();
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
