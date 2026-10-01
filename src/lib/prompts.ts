import type { Daily, GlossaryItem, Lang, Line, Profile, Tone, Turn, Word } from './types';
import { other } from './types';

const LANG = { ko: 'Korean', ja: 'Japanese' } as const;

/* ---------- script checks: catch answers written in the wrong language ---------- */

const count = (text: string, re: RegExp) => (text.match(re) || []).length;
const HANGUL = /[\uac00-\ud7a3\u3131-\u318e]/g;
const KANA = /[\u3041-\u3096\u30a1-\u30fa\u31f0-\u31ff]/g;
const KANJI = /[\u4e00-\u9fff\u3005]/g;

/** True when the text is mostly written in that language's script (a quoted word from the other language is fine). */
export function looksLike(text: string, lang: Lang): boolean {
  const hangul = count(text, HANGUL);
  const japanese = count(text, KANA) + count(text, KANJI);
  if (lang === 'ko') return hangul > 0 && hangul > japanese;
  return japanese > 0 && japanese > hangul;
}

/** koKana must be katakana, jaHangul must be hangul. Empty readings are allowed. */
export function readingOk(text: string, script: 'kana' | 'hangul'): boolean {
  if (!text.trim()) return true;
  const hangul = count(text, HANGUL);
  const kana = count(text, KANA);
  return script === 'kana' ? kana > 0 && hangul === 0 : hangul > 0 && kana + count(text, KANJI) === 0;
}

/** Keeps a reading only if it is in the right script; a wrong one is worse than none. */
export const cleanReading = (text: string | undefined, script: 'kana' | 'hangul') => {
  const value = (text || '').trim();
  return readingOk(value, script) ? value : '';
};

/** Removes furigana like 今日(きょう) that weaker models sometimes add. */
export const stripFurigana = (text: string) => text.replace(/([\u4e00-\u9fff\u3005]+)[(（][\u3041-\u3096\u30a1-\u30faー]+[)）]/g, '$1');
const SCRIPT = { ko: 'hangul', ja: 'katakana' } as const;

const TONE: Record<Tone, string> = {
  sweet: 'sweet and affectionate',
  natural: 'natural, like everyday lovers',
  playful: 'playful and teasing',
  serious: 'sincere and serious',
};

export function names(profile: Profile) {
  const me = profile.myName.trim() || (profile.myLang === 'ko' ? 'K' : 'J');
  const partner = profile.partnerName.trim() || (profile.myLang === 'ko' ? 'J' : 'K');
  return {
    me,
    partner,
    ko: profile.myLang === 'ko' ? me : partner,
    ja: profile.myLang === 'ja' ? me : partner,
  };
}

export function daysTogether(startDate: string, today = new Date()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null;
  const [y, m, d] = startDate.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.floor((now - start) / 86400000) + 1;
  return days >= 1 ? days : null;
}

/** Shared rules for every request: who they are, register, dictionary, how to write readings. */
export function systemPrompt(profile: Profile, glossary: GlossaryItem[], today = new Date()): string {
  const n = names(profile);
  const days = daysTogether(profile.startDate, today);
  const koCalls = profile.myLang === 'ko' ? profile.meCalls : profile.partnerCalls;
  const jaCalls = profile.myLang === 'ja' ? profile.meCalls : profile.partnerCalls;
  const dict = glossary
    .filter((g) => g.ko.trim() && g.ja.trim())
    .slice(0, 80)
    .map((g) => `- ${g.ko.trim()} = ${g.ja.trim()}${g.note?.trim() ? ` (${g.note.trim()})` : ''}`);
  const register =
    profile.style === 'polite'
      ? 'gentle polite speech — Korean 해요체, Japanese です/ます'
      : 'casual speech between lovers — Korean 반말, Japanese タメ口';

  return [
    `You are Duri, the private interpreter and language coach of one couple.`,
    `- ${n.ko}: native Korean speaker, learning Japanese.`,
    `- ${n.ja}: native Japanese speaker, learning Korean.`,
    `They are romantic partners${days ? `, together for ${days} days` : ''}. They talk face to face and by text (LINE/KakaoTalk).`,
    koCalls ? `${n.ko} calls ${n.ja} "${koCalls}".` : '',
    jaCalls ? `${n.ja} calls ${n.ko} "${jaCalls}".` : '',
    ``,
    `TRANSLATION RULES`,
    `1. Translate what was meant, the way real couples in Korea and Japan actually talk: natural spoken language, never stiff textbook phrasing. Keep the speaker's meaning, feeling and level of detail. Do not add, soften or drop content in the main translation.`,
    `2. Register: ${register}, unless the speaker clearly uses another register.`,
    `3. Words in the couple dictionary must be rendered exactly as listed. Never translate personal names: write Korean names in katakana inside Japanese and Japanese names in hangul inside Korean.`,
    `4. Keep emoji, laughter and interjections natural in the other language (ㅋㅋ ↔ www/笑, ㅎㅎ ↔ ふふ, 헐 ↔ えっ).`,
    `5. Silently fix obvious speech-recognition slips, but never invent content.`,
    ``,
    `READING RULES (each of them cannot read the other's script)`,
    `- jaHangul = how the Japanese sounds, written in hangul for a Korean learner. Use the real reading of every kanji in context. っ → ㅅ받침 (行って → 잇테), ん → ㄴ/ㅁ/ㅇ받침 by sound (散歩 → 삼포), long vowels with ー (ありがとう → 아리가토ー, 東京 → 토ー쿄ー), つ → 츠, ず/づ → 즈. Put spaces between words like Korean spacing.`,
    `- koKana = how the Korean sounds, written in katakana for a Japanese learner, AFTER Korean sound changes (연음·비음화·경음화: 먹어요 → モゴヨ, 감사합니다 → カㇺサハㇺニダ, 같이 → カチ). Final consonants with small katakana: ㄱ→ㇰ ㄴ→ン ㄷ→ㇳ ㄹ→ㇽ ㅁ→ㇺ ㅂ→ㇷ゚ ㅇ→ン. Keep Korean word spacing.`,
    ``,
    dict.length ? `COUPLE DICTIONARY (Korean = Japanese)\n${dict.join('\n')}` : `COUPLE DICTIONARY: (empty)`,
    ``,
    `Always answer with one JSON object only.`,
  ]
    .filter((line) => line !== '')
    .join('\n')
    .replace(/\n(TRANSLATION|READING|COUPLE|Always)/g, '\n\n$1');
}

/** Recent turns, oldest first, so pronouns and running jokes carry over. */
export function contextLines(turns: Turn[], profile: Profile, now = Date.now(), max = 8): string {
  const n = names(profile);
  const recent = turns.filter((t) => now - t.ts < 6 * 3600e3).slice(-max);
  if (!recent.length) return '(this is the start of the conversation)';
  return recent
    .map((t) => {
      const who = t.lang === 'ko' ? n.ko : n.ja;
      const said = t.lang === 'ko' ? t.ko : t.ja;
      const shown = t.lang === 'ko' ? (t.useAlt && t.alt ? t.alt.text : t.ja) : t.useAlt && t.alt ? t.alt.text : t.ko;
      const via = t.channel === 'talk' ? 'said' : 'texted';
      return `${who} ${via}: ${said}  →  ${shown}`;
    })
    .join('\n');
}

const str = { type: 'string' };

export const TALK_SCHEMA = {
  type: 'object',
  properties: {
    heard: { type: 'boolean' },
    lang: { type: 'string', enum: ['ko', 'ja'] },
    said: str,
    translation: str,
    koKana: str,
    jaHangul: str,
    alt: str,
    altReading: str,
    altMeaning: str,
    altWhy: str,
    note: str,
  },
  required: ['heard', 'lang', 'said', 'translation', 'koKana', 'jaHangul', 'alt', 'altReading', 'altMeaning', 'altWhy', 'note'],
};

export interface TalkJson {
  heard: boolean;
  lang: Lang;
  said: string;
  translation: string;
  koKana: string;
  jaHangul: string;
  alt: string;
  altReading: string;
  altMeaning: string;
  altWhy: string;
  note: string;
}

export function talkPrompt(opts: {
  profile: Profile;
  turns: Turn[];
  tone: Tone;
  text?: string;
  forceLang?: Lang;
  now?: number;
}): string {
  const { profile, tone, text, forceLang } = opts;
  const n = names(profile);
  return [
    `CONVERSATION SO FAR (oldest first)`,
    contextLines(opts.turns, profile, opts.now),
    ``,
    `NEXT`,
    text != null ? `The next message is: «${text}»` : `The attached audio is the next utterance.`,
    forceLang
      ? `It is spoken in ${LANG[forceLang]} by ${n[forceLang]}.`
      : `It is Korean (${n.ko}) or Japanese (${n.ja}) — detect which.`,
    `Tone the speaker wants for the better line: ${TONE[tone]}.`,
    ``,
    `Return JSON with exactly these keys:`,
    `- heard: false only if there is no intelligible Korean or Japanese speech (then all text fields are "").`,
    `- lang: "ko" or "ja", the language that was spoken/written.`,
    `- said: exactly what was said, in its own language and script, with clean punctuation.`,
    `- translation: the natural translation into the other language (Korean → Japanese, Japanese → Korean). Plain text, no furigana or brackets.`,
    `- koKana: katakana ONLY (no hangul) reading of the Korean text (said if lang is ko, otherwise translation).`,
    `- jaHangul: hangul ONLY (no kana, no kanji) reading of the Japanese text (said if lang is ja, otherwise translation).`,
    `- alt: ONE line in the other language that a native lover would really say for the same intent, in the wanted tone. Same meaning, may be warmer or more idiomatic. "" if translation is already ideal.`,
    `- altReading: reading of alt (hangul if alt is Japanese, katakana if alt is Korean), else "".`,
    `- altMeaning: alt translated back into the speaker's language, else "".`,
    `- altWhy: at most one short sentence in the speaker's language on why alt sounds better, else "".`,
    `- note: "" unless there is a real nuance or culture point the speaker should know (one short sentence in the speaker's language).`,
  ].join('\n');
}

export function validateTalk(json: TalkJson): string | null {
  if (json.heard === false) return null;
  const lang: Lang = json.lang === 'ja' ? 'ja' : 'ko';
  if (!looksLike(json.said || '', lang)) return 'said';
  if (!looksLike(json.translation || '', other(lang))) return 'translation';
  if (!readingOk(json.koKana || '', 'kana')) return 'koKana';
  if (!readingOk(json.jaHangul || '', 'hangul')) return 'jaHangul';
  return null;
}

export function turnFromTalk(json: TalkJson, meta: { channel?: Turn['channel']; input: Turn['input']; model: string; ms: number; id: string; ts: number }): Turn {
  const lang: Lang = json.lang === 'ja' ? 'ja' : 'ko';
  const said = stripFurigana((json.said || '').trim());
  const translation = stripFurigana((json.translation || '').trim());
  let alt = stripFurigana((json.alt || '').trim());
  if (alt && !looksLike(alt, other(lang))) alt = '';
  const sameAsTranslation = alt && alt.replace(/[\s。.!！?？、,]/g, '') === translation.replace(/[\s。.!！?？、,]/g, '');
  return {
    id: meta.id,
    ts: meta.ts,
    lang,
    channel: meta.channel || 'talk',
    input: meta.input,
    ko: lang === 'ko' ? said : translation,
    ja: lang === 'ja' ? said : translation,
    koKana: cleanReading(json.koKana, 'kana'),
    jaHangul: cleanReading(json.jaHangul, 'hangul'),
    alt:
      alt && !sameAsTranslation
        ? {
            text: alt,
            reading: (json.altReading || '').trim(),
            meaning: (json.altMeaning || '').trim(),
            why: (json.altWhy || '').trim(),
          }
        : undefined,
    note: (json.note || '').trim() || undefined,
    model: meta.model,
    ms: meta.ms,
  };
}

const lineSchema = {
  type: 'object',
  properties: { label: str, text: str, reading: str, meaning: str, why: str },
  required: ['label', 'text', 'reading', 'meaning', 'why'],
};

export const UNDERSTAND_SCHEMA = {
  type: 'object',
  properties: {
    lang: { type: 'string', enum: ['ko', 'ja'] },
    translation: str,
    koKana: str,
    jaHangul: str,
    nuance: str,
    words: {
      type: 'array',
      maxItems: 4,
      items: { type: 'object', properties: { w: str, r: str, m: str }, required: ['w', 'r', 'm'] },
    },
    replies: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: { type: 'object', properties: { text: str, reading: str, meaning: str }, required: ['text', 'reading', 'meaning'] },
    },
  },
  required: ['lang', 'translation', 'koKana', 'jaHangul', 'nuance', 'words', 'replies'],
};

export interface UnderstandJson {
  lang: Lang;
  translation: string;
  koKana: string;
  jaHangul: string;
  nuance: string;
  words: Word[];
  replies: { text: string; reading: string; meaning: string }[];
}

export function understandPrompt(opts: { profile: Profile; turns: Turn[]; text: string; now?: number }): string {
  const { profile } = opts;
  const n = names(profile);
  const mine = profile.myLang;
  const theirs = other(mine);
  return [
    `RECENT CONVERSATION (oldest first)`,
    contextLines(opts.turns, profile, opts.now),
    ``,
    `${n.partner} just sent ${n.me} this text message: «${opts.text}»`,
    `${n.me} reads ${LANG[mine]} and wants to understand it fully.`,
    ``,
    `Return JSON with exactly these keys:`,
    `- lang: "ko" or "ja", the language the message is written in.`,
    `- translation: natural translation into the other language.`,
    `- koKana: katakana ONLY reading of the Korean text (message or translation).`,
    `- jaHangul: hangul ONLY reading of the Japanese text (message or translation).`,
    `- nuance: 1–2 short sentences in ${LANG[mine]}: the feeling and intent behind it (e.g. teasing, a little sulky, wants attention, just casual) and anything easy to misread. If the message is written in ${LANG[mine]} (the partner practising), praise kindly and point out anything unnatural.`,
    `- words: up to 4 useful words or expressions from the message: w = as written, r = reading in ${SCRIPT[mine]}, m = meaning in ${LANG[mine]}. [] if none worth learning.`,
    `- replies: 3 short natural replies that ${n.me} (the reader) could send back to ${n.partner}, spoken in ${n.me}'s voice. text MUST be written in ${LANG[theirs]} (never ${LANG[mine]}) so ${n.partner} can read it; vary the feel (sweet / playful / simple). reading = reading of text in ${SCRIPT[mine]} only; meaning = text translated into ${LANG[mine]}.`,
  ].join('\n');
}

export function validateUnderstand(json: UnderstandJson, profile: Profile): string | null {
  const lang: Lang = json.lang === 'ko' ? 'ko' : 'ja';
  if (!looksLike(json.translation || '', other(lang))) return 'translation';
  const theirs = other(profile.myLang);
  if (!(json.replies || []).length || json.replies.some((r) => !looksLike(r?.text || '', theirs))) return 'replies';
  if (!readingOk(json.koKana || '', 'kana') || !readingOk(json.jaHangul || '', 'hangul')) return 'reading';
  return null;
}

export function turnFromUnderstand(json: UnderstandJson, text: string, meta: { model: string; ms: number; id: string; ts: number; myLang: Lang }): Turn {
  const lang: Lang = json.lang === 'ko' ? 'ko' : 'ja';
  return {
    id: meta.id,
    ts: meta.ts,
    lang,
    channel: 'msg-in',
    input: 'text',
    ko: lang === 'ko' ? text : stripFurigana((json.translation || '').trim()),
    ja: lang === 'ja' ? text : stripFurigana((json.translation || '').trim()),
    koKana: cleanReading(json.koKana, 'kana'),
    jaHangul: cleanReading(json.jaHangul, 'hangul'),
    nuance: (json.nuance || '').trim() || undefined,
    words: (json.words || []).filter((w) => w?.w).slice(0, 4),
    lines: (json.replies || [])
      .filter((r) => r?.text && looksLike(r.text, other(meta.myLang)))
      .slice(0, 3)
      .map((r) => ({ ...r, text: stripFurigana(r.text) })),
    model: meta.model,
    ms: meta.ms,
  };
}

export const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    said: str,
    lines: { type: 'array', minItems: 3, maxItems: 3, items: lineSchema },
    myKana: str,
    note: str,
  },
  required: ['said', 'lines', 'myKana', 'note'],
};

export interface WriteJson {
  said: string;
  lines: Line[];
  myKana: string;
  note: string;
}

export function writePrompt(opts: {
  profile: Profile;
  turns: Turn[];
  tone: Tone;
  text?: string;
  replyTo?: string;
  now?: number;
}): string {
  const { profile, tone } = opts;
  const n = names(profile);
  const mine = profile.myLang;
  const theirs = other(mine);
  return [
    `RECENT CONVERSATION (oldest first)`,
    contextLines(opts.turns, profile, opts.now),
    ``,
    opts.replyTo ? `${n.partner} sent: «${opts.replyTo}»` : '',
    opts.text != null
      ? `${n.me} wants to text ${n.partner} this (may be rough, in any language): «${opts.text}»`
      : `The attached audio is ${n.me} saying what they want to text ${n.partner}.`,
    `Wanted tone: ${TONE[tone]}.`,
    ``,
    `Return JSON with exactly these keys:`,
    `- said: what ${n.me} wants to say, cleaned up, in ${LANG[mine]}.`,
    `- lines: exactly 3 messages, each text written in ${LANG[theirs]} (never ${LANG[mine]}), the way a native ${LANG[theirs]} lover would actually text it, in ${n.me}'s voice:`,
    `  1) faithful and natural, 2) in the wanted tone, 3) shorter and more casual. Each has:`,
    `  label = 2–4 words in ${LANG[mine]} naming the style; text (in ${LANG[theirs]}); reading = reading of text in ${SCRIPT[mine]} only; meaning = back-translation into ${LANG[mine]}; why = at most one short sentence in ${LANG[mine]}.`,
    `- myKana: reading of "said" in ${SCRIPT[theirs]} (katakana for Korean, hangul for Japanese).`,
    `- note: "" or one short tip in ${LANG[mine]} if something could be misread.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function validateWrite(json: WriteJson, profile: Profile): string | null {
  const lines = json.lines || [];
  const theirs = other(profile.myLang);
  if (!lines.length || lines.some((l) => !looksLike(l?.text || '', theirs))) return 'lines';
  if (lines.some((l) => !readingOk(l?.reading || '', profile.myLang === 'ko' ? 'hangul' : 'kana'))) return 'reading';
  return null;
}

export function turnFromWrite(json: WriteJson, meta: { profile: Profile; input: Turn['input']; model: string; ms: number; id: string; ts: number }): Turn {
  const mine = meta.profile.myLang;
  const lines = (json.lines || [])
    .filter((l) => l?.text && looksLike(l.text, other(mine)))
    .slice(0, 3)
    .map((l) => ({ ...l, text: stripFurigana(l.text) }));
  const first = lines[0] || { text: '', reading: '' };
  const said = (json.said || '').trim();
  return {
    id: meta.id,
    ts: meta.ts,
    lang: mine,
    channel: 'msg-out',
    input: meta.input,
    ko: mine === 'ko' ? said : first.text,
    ja: mine === 'ja' ? said : first.text,
    koKana: mine === 'ko' ? cleanReading(json.myKana, 'kana') : cleanReading(first.reading, 'kana'),
    jaHangul: mine === 'ja' ? cleanReading(json.myKana, 'hangul') : cleanReading(first.reading, 'hangul'),
    lines,
    note: (json.note || '').trim() || undefined,
    model: meta.model,
    ms: meta.ms,
  };
}

export const PRONOUNCE_SCHEMA = {
  type: 'object',
  properties: {
    heard: str,
    score: { type: 'integer', minimum: 1, maximum: 5 },
    good: str,
    tip: str,
  },
  required: ['heard', 'score', 'good', 'tip'],
};

export interface PronounceJson {
  heard: string;
  score: number;
  good: string;
  tip: string;
}

export function pronouncePrompt(opts: { profile: Profile; target: string; targetLang: Lang; reading: string }): string {
  const mine = opts.profile.myLang;
  return [
    `A native ${LANG[mine]} speaker is practising saying this ${LANG[opts.targetLang]} line out loud:`,
    `«${opts.target}»${opts.reading ? ` (reading they see: ${opts.reading})` : ''}`,
    `Listen to the attached recording and coach them kindly.`,
    ``,
    `Return JSON with exactly these keys:`,
    `- heard: what you actually heard, written in ${LANG[opts.targetLang]} ("" if nothing intelligible).`,
    `- score: 1–5 (5 = a native would understand instantly and it sounds natural; 3 = understandable with effort).`,
    `- good: one short sentence in ${LANG[mine]} praising something specific.`,
    `- tip: at most two short sentences in ${LANG[mine]} with the single most useful fix, naming the exact syllable (show it in both scripts when helpful).`,
  ].join('\n');
}

export const DAILY_SCHEMA = {
  type: 'object',
  properties: { line: str, meaning: str, koKana: str, jaHangul: str, note: str },
  required: ['line', 'meaning', 'koKana', 'jaHangul', 'note'],
};

export interface DailyJson {
  line: string;
  meaning: string;
  koKana: string;
  jaHangul: string;
  note: string;
}

export function dailyPrompt(opts: { profile: Profile; turns: Turn[]; known: string[]; today: Date }): string {
  const n = names(opts.profile);
  const mine = opts.profile.myLang;
  const theirs = other(mine);
  const topics = opts.turns
    .slice(-12)
    .map((t) => (mine === 'ko' ? t.ko : t.ja))
    .filter(Boolean)
    .join(' / ');
  const date = opts.today.toISOString().slice(0, 10);
  return [
    `Suggest ONE short, useful line for ${n.me} to learn today and actually say to ${n.partner}, written in ${LANG[theirs]}.`,
    `Make it fit a loving couple and, if possible, their recent topics: ${topics || '(none yet)'}.`,
    `Today is ${date}; the season or a nearby holiday in Korea/Japan may inspire it. Avoid lines they already know: ${opts.known.slice(0, 30).join(' / ') || '(none)'}.`,
    ``,
    `Return JSON with exactly these keys:`,
    `- line: the line, written in ${LANG[theirs]} (never ${LANG[mine]}), in ${n.me}'s voice speaking to ${n.partner}.`,
    `- meaning: its meaning in ${LANG[mine]}.`,
    `- koKana: katakana reading of the Korean text (line or meaning).`,
    `- jaHangul: hangul reading of the Japanese text (line or meaning).`,
    `- note: one short sentence in ${LANG[mine]} on when to use it.`,
  ].join('\n');
}

export function validateDaily(json: DailyJson, profile: Profile): string | null {
  if (!looksLike(json.line || '', other(profile.myLang))) return 'line';
  if (!looksLike(json.meaning || '', profile.myLang)) return 'meaning';
  return null;
}

export function dailyFrom(json: DailyJson, profile: Profile, date: string): Daily {
  const theirs = other(profile.myLang);
  return {
    date,
    ko: stripFurigana(theirs === 'ko' ? json.line : json.meaning),
    ja: stripFurigana(theirs === 'ja' ? json.line : json.meaning),
    koKana: json.koKana || '',
    jaHangul: json.jaHangul || '',
    note: json.note || '',
  };
}

export const FILL_SCHEMA = {
  type: 'object',
  properties: { ko: str, ja: str },
  required: ['ko', 'ja'],
};

export function fillPrompt(item: { ko: string; ja: string; note?: string }): string {
  return [
    `Fill in the missing side of this couple-dictionary entry so the pair means the same thing.`,
    `Korean: «${item.ko}»  Japanese: «${item.ja}»${item.note ? `  Note: ${item.note}` : ''}`,
    `If it is a personal name, transliterate (Korean name → katakana, Japanese name → hangul).`,
    `Return JSON: {"ko": "...", "ja": "..."}`,
  ].join('\n');
}
