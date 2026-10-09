import { describe, expect, it } from 'vitest';
import { fieldDone, parsePartial } from '../src/lib/partial';

describe('reading JSON that is still arriving', () => {
  it('returns finished fields and the string being typed', () => {
    const p = parsePartial<any>('{"heard":true,"lang":"ko","said":"오늘 우리","translation":"今日');
    expect(p.value).toEqual({ heard: true, lang: 'ko', said: '오늘 우리', translation: '今日' });
    expect(p.open).toBe('translation');
    expect(fieldDone(p, 'said')).toBe(true);
    expect(fieldDone(p, 'translation')).toBe(false);
    expect(p.done).toBe(false);
  });
  it('knows a field is finished once the separator after it arrives', () => {
    const closing = parsePartial<any>('{"said":"안녕","translation":"こんにちは"');
    expect(closing.value.translation).toBe('こんにちは');
    expect(fieldDone(closing, 'translation')).toBe(false);
    expect(fieldDone(parsePartial<any>('{"said":"안녕","translation":"こんにちは",'), 'translation')).toBe(true);
    expect(fieldDone(parsePartial<any>('{"said":"안녕","translation":"こんにちは"}'), 'translation')).toBe(true);
  });
  it('never calls a field finished when garbage follows it (Codex review2 M1)', () => {
    const p = parsePartial<any>('{"translation":"안녕"x');
    expect(fieldDone(p, 'translation')).toBe(false);
    expect(fieldDone(parsePartial<any>('{"translation":"안녕" "said":"hi"'), 'translation')).toBe(false);
    expect(parsePartial<any>('{"n":1e').value.n).toBeUndefined();
  });
  it('handles escapes, unicode and a cut-off escape', () => {
    expect(parsePartial<any>('{"a":"줄\\n바꿈 \\"따옴\\" \\u3042"}').value.a).toBe('줄\n바꿈 "따옴" あ');
    expect(parsePartial<any>('{"a":"끝\\').value.a).toBe('끝');
    expect(parsePartial<any>('{"a":"\\u30').value.a).toBe('');
  });
  it('does not trust a number or literal that may still be growing', () => {
    expect(parsePartial<any>('{"score":4').value.score).toBeUndefined();
    expect(parsePartial<any>('{"score":4,').value.score).toBe(4);
    expect(parsePartial<any>('{"heard":tru').value.heard).toBeUndefined();
  });
  it('reads arrays of objects as they fill', () => {
    const p = parsePartial<any>('{"lines":[{"text":"一","reading":"이"},{"text":"二');
    expect(p.value.lines).toEqual([{ text: '一', reading: '이' }, { text: '二' }]);
    expect(p.open).toBe('lines');
  });
  it('skips text before the object and finishes cleanly', () => {
    const p = parsePartial<any>('```json\n{"ok":true}');
    expect(p.value).toEqual({ ok: true });
    expect(p.done).toBe(true);
  });
});
