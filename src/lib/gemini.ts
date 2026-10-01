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

export const MODELS: ModelSpec[] = [
  { id: 'gemini-3.8-flash', thinking: 'low' },
  { id: 'gemini-3.6-flash', thinking: 'minimal' },
  { id: 'gemini-3.5-flash-lite', thinking: 'minimal' },
  { id: 'gemini-3.7-flash', thinking: 'low' },
  { id: 'gemini-3.5-flash', thinking: 'low' },
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
}

export async function callGemini<T = any>(opts: {
  key: string;
  system: string;
  parts: Part[];
  schema?: object;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  models?: ModelSpec[];
  onModel?: (model: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<CallResult<T>> {
  const key = opts.key.trim();
  if (!key) throw new GeminiError('nokey');
  const doFetch = opts.fetchImpl || (import.meta.env.DEV && key === 'mock' ? mockFetch : fetch.bind(globalThis));
  const timeoutMs = opts.timeoutMs ?? 25000;
  const errors: GeminiError[] = [];
  const models = opts.models || orderedModels();

  for (const spec of models) {
    let lite = !!readHealth()[spec.id]?.lite;
    let maxTokens = opts.maxTokens ?? 4096;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (opts.signal?.aborted) throw new GeminiError('aborted');
      opts.onModel?.(spec.id);
      const controller = new AbortController();
      const onOuterAbort = () => controller.abort();
      opts.signal?.addEventListener('abort', onOuterAbort);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = Date.now();
      try {
        const response = await doFetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${spec.id}:generateContent`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify(
              buildBody({
                system: opts.system,
                parts: opts.parts,
                schema: opts.schema,
                spec,
                lite,
                maxTokens,
                temperature: opts.temperature ?? 0.4,
              }),
            ),
            signal: controller.signal,
          },
        );
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
          if (action === 'stop') throw error;
          if (action === 'lite' && !lite) {
            lite = true;
            note(spec.id, { lite: true });
            continue;
          }
          errors.push(error);
          const hardQuota = response.status === 429 && /limit:\s*0\b|free.?tier.*0/i.test(message);
          const cool =
            response.status === 404 || response.status === 403 || hardQuota
              ? 6 * 3600e3
              : response.status === 429
                ? 60e3
                : 30e3;
          note(spec.id, { skipUntil: Date.now() + cool, reason: String(response.status) });
          break;
        }
        const raw = await response.json();
        const { text, finish, blocked } = answerText(raw);
        if (blocked || finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT') {
          record(spec.id, `blocked ${blocked || finish}`, ms);
          throw new GeminiError('blocked', 200, blocked || finish);
        }
        if (!text) {
          record(spec.id, `empty ${finish}`, ms);
          if (finish === 'MAX_TOKENS' && attempt === 0) {
            maxTokens *= 2;
            continue;
          }
          errors.push(new GeminiError('format', 200, `empty ${finish}`));
          break;
        }
        let data: T;
        try {
          data = parseJsonLoose(text);
        } catch {
          record(spec.id, `bad json ${finish}`, ms);
          if (finish === 'MAX_TOKENS' && attempt === 0) {
            maxTokens *= 2;
            continue;
          }
          errors.push(new GeminiError('format', 200, `bad json ${finish}`));
          break;
        }
        record(spec.id, 'ok', ms);
        note(spec.id, { okAt: Date.now(), ms, skipUntil: 0, reason: '' });
        return { data, model: spec.id, ms };
      } catch (caught) {
        if (caught instanceof GeminiError) throw caught;
        const ms = Date.now() - started;
        if (opts.signal?.aborted) throw new GeminiError('aborted');
        if (caught instanceof DOMException && caught.name === 'AbortError') {
          record(spec.id, 'timeout', ms);
          errors.push(new GeminiError('timeout'));
          note(spec.id, { skipUntil: Date.now() + 20e3, reason: 'timeout' });
          break;
        }
        record(spec.id, `network ${(caught as Error)?.message || ''}`.slice(0, 90), ms);
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new GeminiError('network');
        errors.push(new GeminiError('network'));
        break;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onOuterAbort);
      }
    }
  }
  errors.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
  throw errors[0] || new GeminiError('model');
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
