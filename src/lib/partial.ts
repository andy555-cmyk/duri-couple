/**
 * Reads JSON that is still arriving. Returns everything that can be read so far:
 * finished fields, the unfinished string being written (so it can be shown as it types),
 * and which top-level key is still open.
 *
 *   parsePartial('{"said":"안녕","translation":"こん')
 *   → { value: { said: '안녕', translation: 'こん' }, open: 'translation', done: false }
 */
export interface Partial<T = Record<string, unknown>> {
  value: T;
  open: string | null;
  done: boolean;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };

export function parsePartial<T = Record<string, unknown>>(text: string): Partial<T> {
  const start = text.indexOf('{');
  if (start < 0) return { value: {} as T, open: null, done: false };
  const s = text;
  let i = start;
  let open: string | null = null;

  const ws = () => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t')) i++;
  };

  function str(): { v: string; ok: boolean } {
    i++;
    let out = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '"') {
        i++;
        return { v: out, ok: true };
      }
      if (c === '\\') {
        if (i + 1 >= s.length) break;
        const e = s[i + 1];
        if (e === 'u') {
          if (i + 6 > s.length) break;
          out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        out += ESCAPES[e] ?? e;
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return { v: out, ok: false };
  }

  function value(depth: number): { v: unknown; ok: boolean } {
    ws();
    if (i >= s.length) return { v: undefined, ok: false };
    const c = s[i];
    if (c === '{') return obj(depth + 1);
    if (c === '[') return arr(depth + 1);
    if (c === '"') return str();
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(i, i + 40));
    // A literal is only trusted once a delimiter follows it: "tru", "12" or "1e" may still be growing.
    if (m && /[\s,}\]]/.test(s[i + m[0].length] ?? '')) {
      i += m[0].length;
      return { v: JSON.parse(m[0]), ok: true };
    }
    return { v: undefined, ok: false };
  }

  function obj(depth: number): { v: Record<string, unknown>; ok: boolean } {
    i++;
    const o: Record<string, unknown> = {};
    for (;;) {
      ws();
      if (i >= s.length) return { v: o, ok: false };
      if (s[i] === '}') {
        i++;
        return { v: o, ok: true };
      }
      if (s[i] === ',') {
        i++;
        continue;
      }
      if (s[i] !== '"') return { v: o, ok: false };
      const key = str();
      if (!key.ok) return { v: o, ok: false };
      ws();
      if (s[i] !== ':') return { v: o, ok: false };
      i++;
      const val = value(depth);
      if (val.v !== undefined) o[key.v] = val.v;
      if (!val.ok) {
        if (depth === 1) open = key.v;
        return { v: o, ok: false };
      }
      // A value only counts as finished once the separator after it has arrived (Codex review2 M1).
      ws();
      if (i >= s.length || (s[i] !== ',' && s[i] !== '}')) {
        if (depth === 1) open = key.v;
        return { v: o, ok: false };
      }
    }
  }

  function arr(depth: number): { v: unknown[]; ok: boolean } {
    i++;
    const a: unknown[] = [];
    for (;;) {
      ws();
      if (i >= s.length) return { v: a, ok: false };
      if (s[i] === ']') {
        i++;
        return { v: a, ok: true };
      }
      if (s[i] === ',') {
        i++;
        continue;
      }
      const val = value(depth);
      if (val.v !== undefined) a.push(val.v);
      if (!val.ok) return { v: a, ok: false };
      ws();
      if (i >= s.length || (s[i] !== ',' && s[i] !== ']')) return { v: a, ok: false };
    }
  }

  const root = obj(1);
  return { value: root.v as T, open: root.ok ? null : open, done: root.ok };
}

/** True once a top-level field has been written completely. */
export const fieldDone = <T,>(p: Partial<T>, key: string) => key in (p.value as Record<string, unknown>) && p.open !== key;
