import { isKanaOnly, kanaToHangul, koreanToKatakana, tidyJapanese, tidyKorean } from './kana';
import type { Daily, Gender, GlossaryItem, Lang, Line, Profile, Tone, Turn, Word } from './types';
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

/** Quoted phrases may legitimately be in the other language (「사랑해」って言って, ‘好き’라고 말해 줘). */
const unquoted = (text: string) => text.replace(/「[^」]*」|『[^』]*』|"[^"]*"|“[^”]*”|‘[^’]*’|'[^']*'|（[^）]*）|\([^)]*\)|\[[^\]]*\]/g, '');
/** Laughs, cries, emoji and punctuation alone belong to no language (ｗｗ, ㅋㅋ, 😭). */
const CHAT_ONLY = /^[\s\p{Extended_Pictographic}\uFE0F\u200Dｗwㅋㅎㅠㅜ笑泣!?！？…〜~.。、,♡♥]+$/u;
const ANY_HANGUL = /[\uac00-\ud7a3\u3131-\u318e]/;
const ANY_JAPANESE = /[\u3041-\u3096\u30a1-\u30fa\u31f0-\u31ff\u4e00-\u9fff\u3005]/;

/**
 * Text in one language with no stray characters of the other: シ오리 or ㅇㅇ in Japanese, 本当 in
 * Korean are defects in a translation (Codex review2 M7). Quoted phrases are allowed.
 */
export function cleanIn(text: string, lang: Lang): boolean {
  const bare = unquoted(text).trim();
  // All of it in quotes (「사랑해」 as a "translation") is judged as it is.
  if (!bare) return looksLike(text, lang);
  if (CHAT_ONLY.test(bare)) return true;
  if (!looksLike(bare, lang)) return false;
  return lang === 'ja' ? !ANY_HANGUL.test(bare) : !ANY_JAPANESE.test(bare);
}

/** Tidies chat habits for the language, then removes furigana. */
export const tidyIn = (text: string, lang: Lang) => stripFurigana(lang === 'ja' ? tidyJapanese(text.trim()) : tidyKorean(text.trim()));

/** Reading of a Japanese text in hangul, from the model's pronunciation kana. */
export const jaReading = (kana: string | undefined) => (kana && isKanaOnly(kana) ? kanaToHangul(kana) : '');

/** Reading of a line in the viewer's script: Korean by rule, Japanese from the model's kana. */
export const readingFor = (text: string, lang: Lang, kana?: string) => (lang === 'ko' ? koreanToKatakana(text) : jaReading(kana));

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

// What a term of address says about who uses it and who hears it: [term, speaker, listener].
const ADDRESS_GENDER: [RegExp, Gender, Gender][] = [
  [/오빠|オッパ|おっぱ/, 'f', 'm'],
  [/언니|オンニ|おんに/, 'f', 'f'],
  [/누나|ヌナ|ぬな/, 'm', 'f'],
  [/^(?:형|형님|형아)$|ヒョン/, 'm', 'm'],
];

/** When the profile leaves gender open, 오빠/언니/누나/형 in the nicknames still tell (she calls him オッパ). */
export function inferGenders(profile: Profile): { me: Gender; partner: Gender } {
  const me = new Set<Gender>();
  const partner = new Set<Gender>();
  for (const [term, speaker, listener] of ADDRESS_GENDER) {
    if (term.test(profile.partnerCalls.trim())) {
      partner.add(speaker);
      me.add(listener);
    }
    if (term.test(profile.meCalls.trim())) {
      me.add(speaker);
      partner.add(listener);
    }
  }
  // Only when every hint agrees (a playful '오빠/누나' says nothing) — Codex review3.
  const one = (set: Set<Gender>): Gender => (set.size === 1 ? [...set][0] : '');
  return { me: one(me), partner: one(partner) };
}

/** Gender of the Korean speaker and of the Japanese speaker: as set in the profile, else as the nicknames imply. */
export function genders(profile: Profile): { ko: string; ja: string } {
  const label = (g: string | undefined) => (g === 'm' ? 'a man' : g === 'f' ? 'a woman' : '');
  const guess = inferGenders(profile);
  const me = profile.meGender || guess.me;
  const partner = profile.partnerGender || guess.partner;
  return profile.myLang === 'ko' ? { ko: label(me), ja: label(partner) } : { ko: label(partner), ja: label(me) };
}

const VOICE_RULE =
  'Each person keeps their own voice. In Japanese a man says 俺 or 僕 with masculine casual endings (〜だよ, 〜んだ, 〜だな); a woman says 私 or あたし with her own natural endings; leave the pronoun out when natural Japanese would.';

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
  const g = genders(profile);
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
    `- ${n.ko}: native Korean speaker${g.ko ? `, ${g.ko}` : ''}, learning Japanese.`,
    `- ${n.ja}: native Japanese speaker${g.ja ? `, ${g.ja}` : ''}, learning Korean.`,
    `They are romantic partners${days ? `, together for ${days} days` : ''}. They talk face to face and by text (LINE/KakaoTalk).`,
    koCalls ? `${n.ko} calls ${n.ja} "${koCalls}".` : '',
    jaCalls ? `${n.ja} calls ${n.ko} "${jaCalls}".` : '',
    ``,
    `TRANSLATION RULES`,
    `1. Translate what was meant, the way real couples in Korea and Japan actually talk: natural spoken language, never stiff textbook phrasing. Keep the speaker's meaning, feeling and level of detail. Do not add, soften or drop content in the main translation: no reasons, events or feelings that were not said (수고 많았어 → お疲れ様, never 今日はいろいろあって…), and the same strength of emphasis (one 진짜 → one 本当に).`,
    `2. Register: ${register}, unless the speaker clearly uses another register.`,
    `3. Words in the couple dictionary must be rendered exactly as listed. Never translate personal names: write Korean names in katakana inside Japanese and Japanese names in hangul inside Korean.`,
    `4. Terms of address and endearment are translated from the speaker's point of view (자기야/여보 → ねえ or the partner's name; あなた/ねえ → 자기야). Never swap who calls whom: a nickname one person uses for the other must not be put in the other person's mouth. A plain 너/당신 to a lover becomes the partner's name or is left out — not 君, お前 or あなた.`,
    `5. Keep every person and detail that was mentioned (시오리 엄마 → しおりのお母さん, not just お母さん).`,
    `6. Japanese text contains only Japanese script, Korean text only hangul (plus emoji/punctuation). Convert chat habits: ㅋㅋ ↔ ｗｗ/笑, ㅎㅎ ↔ ふふ, ㅠㅠ ↔ 😭/(泣), 헐 ↔ えっ.`,
    `7. Silently fix obvious speech-recognition slips, but never invent content.`,
    `8. ${VOICE_RULE}${g.ko && g.ja ? '' : ' Where a gender is not given, infer it from terms of address (오빠/オッパ: a woman calling a man; 언니: a woman calling a woman; 형/ヒョン: a man calling a man; 누나/ヌナ: a man calling a woman) and from the conversation; if still unclear, avoid gendered pronouns and endings.'}`,
    ``,
    `PRONUNCIATION KANA (fields named *Kana / kana)`,
    `Write how the JAPANESE text is pronounced, in hiragana only (no kanji, no hangul, no romaji), covering everything readable including chat marks (笑 → わら): particles as pronounced (は→わ, へ→え, を→お), long vowels with ー (ありがとう → ありがとー, 東京 → とーきょー, 先生 → せんせー), っ and ん as usual, a space between words. Korean text never needs a kana field — leave such fields "".`,
    ``,
    dict.length ? `COUPLE DICTIONARY (Korean = Japanese)\n${dict.join('\n')}` : `COUPLE DICTIONARY: (empty)`,
    ``,
    `Always answer with one JSON object only.`,
  ]
    .filter((line) => line !== '')
    .join('\n')
    .replace(/\n(TRANSLATION|PRONUNCIATION|COUPLE|Always)/g, '\n\n$1');
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
    jaKana: str,
    alt: str,
    altKana: str,
    altMeaning: str,
    altWhy: str,
    note: str,
  },
  required: ['heard', 'lang', 'said', 'translation', 'jaKana', 'alt', 'altKana', 'altMeaning', 'altWhy', 'note'],
};

export interface TalkJson {
  heard: boolean;
  lang: Lang;
  said: string;
  translation: string;
  jaKana: string;
  alt: string;
  altKana: string;
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
    `- jaKana: pronunciation kana of the Japanese text (said if lang is ja, otherwise translation).`,
    `- alt: ONE line, only in the other language, that a native lover would really say for the same intent in the wanted tone — only if it is clearly more natural than translation; otherwise "" (and altKana, altMeaning, altWhy ""). Same meaning: no feeling, action, reason, person, place or source of information that was not said. Check its spelling and grammar.`,
    `- altKana: pronunciation kana of alt if alt is Japanese, else "".`,
    `- altMeaning: alt translated back into the speaker's language, else "".`,
    `- altWhy: at most one short sentence in the speaker's language on why alt sounds better, else "".`,
    `- note: usually "". Only for a real nuance or culture point the speaker would want to learn: one short sentence in the speaker's own language (Korean if lang is ko, Japanese if ja). Never explain your own word choices, names, the couple dictionary or these rules.`,
  ].join('\n');
}

export function validateTalk(json: TalkJson): string | null {
  if (json.heard === false) return null;
  const lang: Lang = json.lang === 'ja' ? 'ja' : 'ko';
  // The speaker's own words may mix in the other language (learners do: 오늘 すごく 피곤해); the translation may not.
  if (!looksLike(tidyIn(json.said || '', lang), lang)) return 'said';
  if (!cleanIn(tidyIn(json.translation || '', other(lang)), other(lang))) return 'translation';
  return null;
}

/** Edit distance, for spotting an "alternative" that is the translation with a typo. */
function distance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[y.length];
}

const bare = (s: string) => s.replace(/[\s。.!！?？、,~〜…]/g, '');

/**
 * An alternative earns its place only if it is a real alternative: not the translation again with a
 * letter changed (쉬는 날이래 → 쉬는 날이데), and with a meaning the speaker can read (Codex grading 2026-10-10).
 */
export function worthAlt(alt: string, translation: string, meaning: string): boolean {
  if (!alt || !meaning.trim()) return false;
  const a = bare(alt);
  const t = bare(translation);
  const d = distance(a, t);
  // A changed ending or word can be the better line (会いたいな → 会いたいよ, 통화할래 → 전화할래);
  // one letter off in a long line is a slip (쉬는 날이래 → 쉬는 날이데). Codex review3.
  return d > 1 || (d === 1 && t.length < 8);
}

export function turnFromTalk(json: TalkJson, meta: { channel?: Turn['channel']; input: Turn['input']; model: string; ms: number; id: string; ts: number }): Turn {
  const lang: Lang = json.lang === 'ja' ? 'ja' : 'ko';
  const target = other(lang);
  const said = tidyIn(json.said || '', lang);
  const translation = tidyIn(json.translation || '', target);
  let alt = tidyIn(json.alt || '', target);
  if (alt && (!cleanIn(alt, target) || !worthAlt(alt, translation, json.altMeaning || ''))) alt = '';
  const ko = lang === 'ko' ? said : translation;
  return {
    id: meta.id,
    ts: meta.ts,
    lang,
    channel: meta.channel || 'talk',
    input: meta.input,
    ko,
    ja: lang === 'ja' ? said : translation,
    koKana: koreanToKatakana(ko),
    jaHangul: jaReading(json.jaKana),
    alt: alt
        ? {
            text: alt,
            reading: readingFor(alt, target, json.altKana),
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
  properties: { label: str, text: str, kana: str, meaning: str, why: str },
  required: ['label', 'text', 'kana', 'meaning', 'why'],
};

export const UNDERSTAND_SCHEMA = {
  type: 'object',
  properties: {
    lang: { type: 'string', enum: ['ko', 'ja'] },
    translation: str,
    jaKana: str,
    nuance: str,
    words: {
      type: 'array',
      maxItems: 4,
      items: { type: 'object', properties: { w: str, kana: str, m: str }, required: ['w', 'kana', 'm'] },
    },
    replies: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: { type: 'object', properties: { text: str, kana: str, meaning: str }, required: ['text', 'kana', 'meaning'] },
    },
  },
  required: ['lang', 'translation', 'jaKana', 'nuance', 'words', 'replies'],
};

export interface UnderstandJson {
  lang: Lang;
  translation: string;
  jaKana: string;
  nuance: string;
  words: { w: string; kana: string; m: string }[];
  replies: { text: string; kana: string; meaning: string }[];
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
    `- jaKana: pronunciation kana of the Japanese text (message or translation).`,
    `- nuance: 1–2 short sentences in ${LANG[mine]}: the feeling and intent behind it (e.g. teasing, a little sulky, wants attention, just casual) and anything easy to misread. If the message is written in ${LANG[mine]} (the partner practising), praise kindly and point out anything unnatural.`,
    `- words: up to 4 useful words or expressions from the message: w = as written, kana = its pronunciation kana if it is Japanese else "", m = meaning in ${LANG[mine]}. [] if none worth learning.`,
    `- replies: 3 short natural replies that ${n.me} (the reader) could send back to ${n.partner}, spoken in ${n.me}'s voice. text MUST be written in ${LANG[theirs]} (never ${LANG[mine]}) so ${n.partner} can read it; vary the feel (sweet / playful / simple). kana = pronunciation kana of text if it is Japanese else ""; meaning = text translated into ${LANG[mine]}.`,
  ].join('\n');
}

export function validateUnderstand(json: UnderstandJson, profile: Profile): string | null {
  const lang: Lang = json.lang === 'ko' ? 'ko' : 'ja';
  if (!cleanIn(tidyIn(json.translation || '', other(lang)), other(lang))) return 'translation';
  const theirs = other(profile.myLang);
  if ((json.replies || []).length !== 3 || json.replies.some((r) => !cleanIn(tidyIn(r?.text || '', theirs), theirs))) return 'replies';
  return null;
}

export function turnFromUnderstand(json: UnderstandJson, text: string, meta: { model: string; ms: number; id: string; ts: number; myLang: Lang }): Turn {
  const lang: Lang = json.lang === 'ko' ? 'ko' : 'ja';
  const theirs = other(meta.myLang);
  const translation = tidyIn(json.translation || '', other(lang));
  const ko = lang === 'ko' ? text : translation;
  return {
    id: meta.id,
    ts: meta.ts,
    lang,
    channel: 'msg-in',
    input: 'text',
    ko,
    ja: lang === 'ja' ? text : translation,
    koKana: koreanToKatakana(ko),
    jaHangul: jaReading(json.jaKana),
    nuance: (json.nuance || '').trim() || undefined,
    words: (json.words || [])
      .filter((w) => w?.w)
      .slice(0, 4)
      .map((w): Word => {
        const wordLang: Lang = looksLike(w.w, 'ja') && !looksLike(w.w, 'ko') ? 'ja' : 'ko';
        return { w: w.w, r: wordLang === meta.myLang ? '' : readingFor(w.w, wordLang, w.kana), m: w.m };
      }),
    lines: (json.replies || [])
      .map((r) => ({ ...r, text: tidyIn(r?.text || '', theirs) }))
      .filter((r) => r.text && cleanIn(r.text, theirs))
      .slice(0, 3)
      .map((r): Line => ({ text: r.text, reading: readingFor(r.text, theirs, r.kana), meaning: (r.meaning || '').trim() })),
    model: meta.model,
    ms: meta.ms,
  };
}

export const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    said: str,
    saidKana: str,
    lines: { type: 'array', minItems: 3, maxItems: 3, items: lineSchema },
    note: str,
  },
  required: ['said', 'saidKana', 'lines', 'note'],
};

export interface WriteJson {
  said: string;
  saidKana: string;
  lines: { label: string; text: string; kana: string; meaning: string; why: string }[];
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
    `- saidKana: pronunciation kana of said if it is Japanese, else "".`,
    `- lines: exactly 3 messages, each text written in ${LANG[theirs]} (never ${LANG[mine]}), the way a native ${LANG[theirs]} lover would actually text it, in ${n.me}'s voice:`,
    `  1) faithful and natural, 2) in the wanted tone, 3) shorter and more casual. Each has:`,
    `  label = 2–4 words in ${LANG[mine]} naming the style; text (in ${LANG[theirs]}); kana = pronunciation kana of text if it is Japanese else ""; meaning = back-translation into ${LANG[mine]}; why = at most one short sentence in ${LANG[mine]}.`,
    `- note: "" or one short tip in ${LANG[mine]} if something could be misread. Never explain your own word choices, names or the couple dictionary.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function validateWrite(json: WriteJson, profile: Profile): string | null {
  const lines = json.lines || [];
  const mine = profile.myLang;
  const theirs = other(mine);
  if (lines.length !== 3 || lines.some((l) => !cleanIn(tidyIn(l?.text || '', theirs), theirs))) return 'lines';
  if (!looksLike(tidyIn(json.said || '', mine), mine)) return 'said';
  return null;
}

export function turnFromWrite(json: WriteJson, meta: { profile: Profile; input: Turn['input']; model: string; ms: number; id: string; ts: number }): Turn {
  const mine = meta.profile.myLang;
  const theirs = other(mine);
  const lines: Line[] = (json.lines || [])
    .map((l) => ({ ...l, text: tidyIn(l?.text || '', theirs) }))
    .filter((l) => l.text && cleanIn(l.text, theirs))
    .slice(0, 3)
    .map((l) => ({ label: l.label, text: l.text, reading: readingFor(l.text, theirs, l.kana), meaning: (l.meaning || '').trim(), why: (l.why || '').trim() }));
  const firstRaw = (json.lines || []).find((l) => l && tidyIn(l.text || '', theirs) === lines[0]?.text);
  const cleaned = tidyIn(json.said || '', mine);
  // A wrong-language "said" would put the partner's language into my side of the record.
  const said = looksLike(cleaned, mine) ? cleaned : lines[0]?.meaning && looksLike(lines[0].meaning, mine) ? lines[0].meaning : cleaned;
  const ko = mine === 'ko' ? said : lines[0]?.text || '';
  return {
    id: meta.id,
    ts: meta.ts,
    lang: mine,
    channel: 'msg-out',
    input: meta.input,
    ko,
    ja: mine === 'ja' ? said : lines[0]?.text || '',
    koKana: koreanToKatakana(ko),
    jaHangul: mine === 'ja' ? jaReading(json.saidKana) : jaReading(firstRaw?.kana),
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
  properties: { line: str, meaning: str, kana: str, note: str },
  required: ['line', 'meaning', 'kana', 'note'],
};

export interface DailyJson {
  line: string;
  meaning: string;
  kana: string;
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
    `- kana: pronunciation kana of whichever of line/meaning is Japanese.`,
    `- note: one short sentence in ${LANG[mine]} on when to use it.`,
  ].join('\n');
}

export function validateDaily(json: DailyJson, profile: Profile): string | null {
  const theirs = other(profile.myLang);
  if (!cleanIn(tidyIn(json.line || '', theirs), theirs)) return 'line';
  if (!looksLike(json.meaning || '', profile.myLang)) return 'meaning';
  return null;
}

export function dailyFrom(json: DailyJson, profile: Profile, date: string): Daily {
  const theirs = other(profile.myLang);
  const line = tidyIn(json.line || '', theirs);
  const meaning = tidyIn(json.meaning || '', profile.myLang);
  const ko = theirs === 'ko' ? line : meaning;
  return {
    date,
    ko,
    ja: theirs === 'ja' ? line : meaning,
    koKana: koreanToKatakana(ko),
    jaHangul: jaReading(json.kana),
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

/* ---------- real-time interpreting (Gemini Live) ---------- */

/**
 * Instructions for the Live model. Measured 2026-10-09 (duri-lab/live/general.mjs): with a 1 s pause
 * setting and the "never guess" rule both directions came back exact and casual, ~1.1 s after speech;
 * with 0.5 s it split a sentence at a pause and invented the rest.
 */
export function livePrompt(profile: Profile, glossary: GlossaryItem[]): string {
  const n = names(profile);
  const g = genders(profile);
  const casual = profile.style !== 'polite';
  const dict = glossary
    .filter((g) => g.ko.trim() && g.ja.trim())
    .slice(0, 60)
    .map((g) => `${g.ko.trim()} = ${g.ja.trim()}`)
    .join('; ');
  return [
    `You are the live interpreter between two lovers: ${n.ko} (speaks Korean) and ${n.ja} (speaks Japanese).`,
    casual
      ? 'Whenever you hear Korean, say it in natural casual Japanese (タメ口). Whenever you hear Japanese, say it in natural casual Korean (반말).'
      : 'Whenever you hear Korean, say it in gentle polite Japanese (です/ます). Whenever you hear Japanese, say it in gentle polite Korean (해요체).',
    'Keep the meaning exactly. Never answer, comment, greet or add anything: speak only the translation, warmly, in the speaker\'s mood.',
    'Translate only the words you actually heard in this utterance. If it sounds cut off, translate just that fragment. Never guess and never reuse an earlier sentence.',
    `Personal names are never translated: ${n.ko} and ${n.ja} keep their sound in the other language.`,
    g.ko || g.ja ? `${[g.ko && `${n.ko} is ${g.ko}`, g.ja && `${n.ja} is ${g.ja}`].filter(Boolean).join(' and ')}. ${VOICE_RULE}` : '',
    dict ? `Couple dictionary (always use these words): ${dict}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const READINGS_SCHEMA = {
  type: 'object',
  properties: { jaKana: str },
  required: ['jaKana'],
};

export function readingsPrompt(ja: string): string {
  return [`Japanese: «${ja}»`, 'Return JSON: {"jaKana": pronunciation kana of this Japanese text}.'].join('\n');
}

export function validateReadings(json: { jaKana: string }): string | null {
  return isKanaOnly(json.jaKana || '') ? null : 'jaKana';
}

/** A finished live exchange becomes an ordinary turn (readings are filled in afterwards). */
export function turnFromLive(input: string, output: string, meta: { id: string; ts: number; model: string }): Turn | null {
  const said = input.trim();
  const heard = output.trim();
  if (!said || !heard) return null;
  const lang: Lang = looksLike(said, 'ja') && !looksLike(said, 'ko') ? 'ja' : 'ko';
  if (!looksLike(heard, other(lang))) return null;
  const ko = lang === 'ko' ? said : heard;
  return {
    id: meta.id,
    ts: meta.ts,
    lang,
    channel: 'talk',
    input: 'voice',
    ko,
    ja: lang === 'ja' ? said : heard,
    // Korean is read by rule right away; the Japanese reading needs the model and is filled in later.
    koKana: koreanToKatakana(ko),
    jaHangul: '',
    model: meta.model,
  };
}
