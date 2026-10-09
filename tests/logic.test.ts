import { describe, expect, it } from 'vitest';
import { dictKeys, errorKey, makeT } from '../src/lib/i18n';
import {
  cleanIn,
  cleanReading,
  looksLike,
  stripFurigana,
  validateDaily,
  validateTalk,
  validateUnderstand,
  validateWrite,
  contextLines,
  daysTogether,
  inferGenders,
  livePrompt,
  systemPrompt,
  TALK_SCHEMA,
  talkPrompt,
  turnFromTalk,
  turnFromUnderstand,
  turnFromWrite,
  worthAlt,
} from '../src/lib/prompts';
import { DEFAULT_PROFILE, grade, makeShareLink, mergeById, mergeGlossary, parseBackup, phraseFrom, profileFromShare, readShareHash } from '../src/lib/store';
import type { Profile, Turn } from '../src/lib/types';

const andy: Profile = { ...DEFAULT_PROFILE, myLang: 'ko', myName: 'Andy', partnerName: '시오리', startDate: '2026-01-01', meCalls: '시오리', partnerCalls: 'オッパ' };
const meta = { input: 'voice' as const, model: 'm', ms: 1, id: 'id', ts: 1 };

describe('i18n', () => {
  it('has the same keys in Korean and Japanese', () => {
    expect([...dictKeys.ja].sort()).toEqual([...dictKeys.ko].sort());
  });
  it('fills variables', () => {
    expect(makeT('ko')('dday', { n: 100 })).toBe('100일째');
    expect(makeT('ja')('dday', { n: 100 })).toBe('100日目');
  });
  it('maps every error kind the app raises', () => {
    for (const kind of ['nokey', 'key', 'quota', 'busy', 'timeout', 'network', 'format', 'blocked', 'model', 'silence', 'denied', 'unsupported', 'short'])
      expect(errorKey(kind)).toBeTruthy();
  });
});

describe('days together', () => {
  it('counts the first day as day 1', () => {
    expect(daysTogether('2026-10-02', new Date(2026, 9, 2))).toBe(1);
    expect(daysTogether('2026-01-01', new Date(2026, 9, 2))).toBe(275);
    expect(daysTogether('', new Date())).toBeNull();
    expect(daysTogether('2030-01-01', new Date(2026, 9, 2))).toBeNull();
  });
});

describe('prompts', () => {
  it('carries names, nicknames, register and the dictionary', () => {
    const system = systemPrompt(andy, [{ id: '1', ko: '우리 라멘집', ja: 'いつものラーメン屋', note: '단골' }], new Date(2026, 9, 2));
    expect(system).toContain('Andy: native Korean speaker');
    expect(system).toContain('시오리: native Japanese speaker');
    expect(system).toContain('together for 275 days');
    expect(system).toContain('Andy calls 시오리 "시오리"');
    expect(system).toContain('시오리 calls Andy "オッパ"');
    expect(system).toContain('- 우리 라멘집 = いつものラーメン屋 (단골)');
    expect(system).toContain('반말');
  });
  it('speaks in each person\'s own voice', () => {
    const set = systemPrompt({ ...andy, meGender: 'm', partnerGender: 'f' }, []);
    expect(set).toContain('Andy: native Korean speaker, a man');
    expect(set).toContain('시오리: native Japanese speaker, a woman');
    expect(set).toContain('俺 or 僕');
    expect(set).not.toContain('infer it from terms of address');
    // Not set, but she calls him オッパ: that settles both.
    const inferred = systemPrompt(andy, []);
    expect(inferred).toContain('Andy: native Korean speaker, a man');
    expect(inferred).toContain('시오리: native Japanese speaker, a woman');
    expect(inferGenders({ ...andy, partnerCalls: '', meCalls: '누나' })).toEqual({ me: 'm', partner: 'f' });
    expect(inferGenders({ ...andy, partnerCalls: '준형', meCalls: '' })).toEqual({ me: '', partner: '' });
    // Nothing to go on: the model is told how to read such terms instead of guessing.
    const unset = systemPrompt({ ...andy, partnerCalls: '앤디', meCalls: '시오리' }, []);
    expect(unset).toContain('Andy: native Korean speaker, learning');
    expect(unset).toContain('오빠/オッパ: a woman calling a man');
    // The same Japanese speaker seen from her own phone.
    const hers = systemPrompt({ ...DEFAULT_PROFILE, myLang: 'ja', myName: 'しおり', partnerName: 'Andy', meGender: 'f', partnerGender: 'm' }, []);
    expect(hers).toContain('Andy: native Korean speaker, a man');
    expect(livePrompt({ ...andy, meGender: 'm', partnerGender: 'f' }, [])).toContain('Andy is a man and 시오리 is a woman');
    expect(livePrompt({ ...andy, partnerCalls: '앤디' }, [])).not.toContain('is a man');
  });
  it('lists every schema key in the prompt so lite mode still works', () => {
    const prompt = talkPrompt({ profile: andy, turns: [], tone: 'sweet', text: '보고 싶어' });
    for (const key of TALK_SCHEMA.required) expect(prompt).toContain(`- ${key}:`);
    expect(prompt).toContain('«보고 싶어»');
  });
  it('gives recent context only from the last hours', () => {
    const now = 10 * 3600e3;
    const old: Turn = { id: 'a', ts: 0, lang: 'ko', channel: 'talk', input: 'text', ko: '옛날 말', ja: '昔', koKana: '', jaHangul: '' };
    const fresh: Turn = { ...old, id: 'b', ts: now - 60e3, ko: '배고파', ja: 'お腹すいた' };
    const lines = contextLines([old, fresh], andy, now);
    expect(lines).toContain('Andy said: 배고파  →  お腹すいた');
    expect(lines).not.toContain('옛날');
  });
});

describe('turn mapping', () => {
  it('maps a Korean utterance; the Korean reading comes from code, the Japanese one from kana', () => {
    const turn = turnFromTalk(
      { heard: true, lang: 'ko', said: '보고 싶었어', translation: '会いたかった', jaKana: 'あいたかった', alt: 'ずっと会いたかった', altKana: 'ずっと あいたかった', altMeaning: '계속 보고 싶었어', altWhy: '더 애틋해요', note: '' },
      meta,
    );
    expect(turn).toMatchObject({ lang: 'ko', ko: '보고 싶었어', ja: '会いたかった', koKana: 'ポゴ シポッソ', jaHangul: '아이타캇타' });
    expect(turn.alt).toMatchObject({ text: 'ずっと会いたかった', reading: '즛토 아이타캇타' });
    expect(turn.note).toBeUndefined();
  });
  it('maps a Japanese utterance, tidies chat marks and drops an alt identical to the translation', () => {
    const turn = turnFromTalk(
      { heard: true, lang: 'ja', said: 'ありがとう（笑）', translation: '고마워', jaKana: 'ありがとー', alt: '고마워!', altKana: '', altMeaning: '', altWhy: '', note: '' },
      meta,
    );
    expect(turn).toMatchObject({ lang: 'ja', ja: 'ありがとう（笑）', ko: '고마워', koKana: 'コマウォ', jaHangul: '아리가토오' });
    expect(turn.alt).toBeUndefined();
  });
  it('keeps only alternatives that are real alternatives (Codex grading 2026-10-10)', () => {
    expect(worthAlt('우리 라멘집 오늘 쉬는 날이데😭', '우리 라멘집 오늘 쉬는 날이래😭', '..')).toBe(false);
    expect(worthAlt('지난번 일, 아직 좀 마음에 걸려', '지난번 일, 아직 좀 신경 쓰여', 'この前のこと、まだ気になる')).toBe(true);
    expect(worthAlt('会いたくて眠れなくなっちゃった', '会いたくて眠れないよ', '')).toBe(false);
  });
  it('turns Korean crying marks inside a Japanese translation into an emoji', () => {
    const turn = turnFromTalk(
      { heard: true, lang: 'ko', said: '수고했어ㅠㅠ', translation: 'お疲れ様ㅠㅠ', jaKana: 'おつかれさま', alt: '', altKana: '', altMeaning: '', altWhy: '', note: '' },
      meta,
    );
    expect(turn.ja).toBe('お疲れ様😭');
  });
  it('keeps no Japanese reading when the kana is not kana', () => {
    const turn = turnFromTalk(
      { heard: true, lang: 'ko', said: '안녕', translation: 'やあ', jaKana: '야', alt: '', altKana: '', altMeaning: '', altWhy: '', note: '' },
      meta,
    );
    expect(turn.jaHangul).toBe('');
  });
  it('maps a received message with replies read in the viewer\'s script', () => {
    const turn = turnFromUnderstand(
      { lang: 'ja', translation: '언제 와?', jaKana: 'いつ くるの', nuance: '기다리는 느낌', words: [{ w: 'いつ', kana: 'いつ', m: '언제' }], replies: [{ text: 'すぐ行く', kana: 'すぐ いく', meaning: '금방 갈게' }] },
      'いつ来るの？',
      { model: 'm', ms: 1, id: 'x', ts: 1, myLang: 'ko' },
    );
    expect(turn).toMatchObject({ channel: 'msg-in', ja: 'いつ来るの？', ko: '언제 와?', jaHangul: '이츠 쿠루노', koKana: 'オンジェ ワ?' });
    expect(turn.words?.[0]).toEqual({ w: 'いつ', r: '이츠', m: '언제' });
    expect(turn.lines?.[0]).toMatchObject({ text: 'すぐ行く', reading: '스구 이쿠' });
  });
  it('maps an outgoing message for a Japanese user', () => {
    const turn = turnFromWrite(
      { said: '今日はありがとう', saidKana: 'きょーわ ありがとー', lines: [{ label: '基本', text: '오늘 고마워', kana: '', meaning: '今日ありがとう', why: '' }], note: '' },
      { profile: { ...andy, myLang: 'ja' }, input: 'text', model: 'm', ms: 1, id: 'y', ts: 1 },
    );
    expect(turn).toMatchObject({ lang: 'ja', ja: '今日はありがとう', ko: '오늘 고마워', koKana: 'オヌㇽ コマウォ', jaHangul: '쿄오와 아리가토오' });
    expect(turn.lines?.[0].reading).toBe('オヌㇽ コマウォ');
  });
});

describe('store helpers', () => {
  it('round-trips a share link and swaps the point of view', () => {
    const link = makeShareLink(andy, [{ id: 'g', ko: '시오리', ja: 'しおり', note: '이름' }], 'https://example.com/duri-couple/');
    const payload = readShareHash(new URL(link).hash);
    expect(payload?.fromName).toBe('Andy');
    expect(payload?.glossary[0]).toEqual({ ko: '시오리', ja: 'しおり', note: '이름' });
    const theirs = profileFromShare(payload!, DEFAULT_PROFILE);
    expect(theirs).toMatchObject({ myLang: 'ja', myName: '시오리', partnerName: 'Andy', meCalls: 'オッパ', partnerCalls: '시오리', startDate: '2026-01-01' });
  });
  it('carries both genders across a share link, seen from the other side', () => {
    const link = makeShareLink({ ...andy, meGender: 'm', partnerGender: 'f' }, [], 'https://example.com/duri-couple/');
    const theirs = profileFromShare(readShareHash(new URL(link).hash)!, DEFAULT_PROFILE);
    expect(theirs).toMatchObject({ meGender: 'f', partnerGender: 'm' });
  });
  it('ignores broken links and cleans tampered ones', () => {
    expect(readShareHash('#join=%%%')).toBeNull();
    expect(readShareHash('')).toBeNull();
    const evil = btoa(JSON.stringify({ v: 1, fromLang: 'ko', fromName: { x: 1 }, startDate: 'soon', style: 'weird', fromGender: 'x', glossary: [{ ko: 'a', ja: 'b' }, 5, { ko: 1 }] }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const p = readShareHash(`#join=${evil}`)!;
    expect(p.fromName).toBe('');
    expect(p.startDate).toBe('');
    expect(p.style).toBe('casual');
    expect(p.fromGender).toBe('');
    expect(p.glossary).toEqual([{ ko: 'a', ja: 'b' }]);
  });
  it('merges dictionaries without duplicates', () => {
    const merged = mergeGlossary([{ id: '1', ko: 'a', ja: 'b' }], [{ ko: 'a', ja: 'b' }, { ko: 'c', ja: 'd' }]);
    expect(merged.map((g) => g.ko)).toEqual(['a', 'c']);
  });
  it('spaces repetitions', () => {
    const p = phraseFrom({ ko: '고마워', ja: 'ありがとう', koKana: '', jaHangul: '' });
    const now = Date.now();
    const knew = grade(p, true, now);
    expect(knew.box).toBe(1);
    expect(knew.due).toBe(now + 86400000);
    const missed = grade(knew, false, now);
    expect(missed.box).toBe(0);
    expect(missed.right).toBe(1);
  });
  it('restores backups by merging ids', () => {
    const good = { id: 'a', ts: 2, lang: 'ko', ko: '안녕', ja: 'こんにちは' };
    const backup = parseBackup(
      JSON.stringify({ app: 'duri-couple', profile: { meCalls: '시오리', style: 'polite', myLang: 'xx', meGender: 'm', partnerGender: 7 }, turns: [good, { id: 'bad' }, null], phrases: [{ id: 1 }], glossary: 'nope' }),
    );
    expect(backup.turns).toHaveLength(1);
    expect(backup.phrases).toHaveLength(0);
    expect(backup.glossary).toHaveLength(0);
    expect(backup.profile).toMatchObject({ meCalls: '시오리', style: 'polite', myLang: 'ko', meGender: 'm', partnerGender: '' });
    expect(mergeById([{ id: 'b', ts: 1 }], backup.turns as any).map((x: any) => x.id)).toEqual(['b', 'a']);
    expect(() => parseBackup('{"app":"other"}')).toThrow();
  });
});

describe('catching wrong-language answers (real Gemini mistakes, 2026-10-02)', () => {
  it('tells the scripts apart, tolerating a quoted word', () => {
    expect(looksLike('今日いつものラーメン屋行かない？', 'ja')).toBe(true);
    expect(looksLike('7시에 끝나요. 끝나면 바로 갈게요', 'ja')).toBe(false);
    expect(looksLike('오늘 우리 라멘집 갈래?', 'ko')).toBe(true);
    expect(looksLike('今日終わったら우리 라멘집に行く？', 'ja')).toBe(true);
    expect(looksLike('', 'ko')).toBe(false);
  });
  it('rejects readings in the wrong script', () => {
    expect(cleanReading('オヌㇽ チンチャ チェミイッソッソ', 'kana')).toBe('オヌㇽ チンチャ チェミイッソッソ');
    expect(cleanReading('オヌㇰ チイン짜 コマワッソ. タウㇺ 주에 또 만나자.', 'kana')).toBe('');
    expect(cleanReading('쿄ー와 혼토ー니 아리가토네', 'hangul')).toBe('쿄ー와 혼토ー니 아리가토네');
    expect(cleanReading('일주일 동안 今日', 'hangul')).toBe('');
  });
  it('strips furigana', () => {
    expect(stripFurigana('今日(きょう)は本当(ほんとう)にありがとね。来週（らいしゅう）')).toBe('今日は本当にありがとね。来週');
  });
  it('flags replies written in the reader\'s own language', () => {
    const bad = { lang: 'ja' as const, translation: '오늘 몇 시에 끝나?', jaKana: '', nuance: '', words: [], replies: [{ text: '나도 시오리 빨리 보고 싶어!', kana: '', meaning: '' }] };
    expect(validateUnderstand(bad, andy)).toBe('replies');
    const reply = { text: '俺も早く会いたい！', kana: 'おれも はやく あいたい', meaning: '나도 빨리 보고 싶어!' };
    expect(validateUnderstand({ ...bad, replies: [reply, reply, reply] }, andy)).toBeNull();
    // Fewer than three replies goes to another model first (Codex review2 M7).
    expect(validateUnderstand({ ...bad, replies: [reply] }, andy)).toBe('replies');
  });
  it('flags message drafts in the wrong language', () => {
    const bad = { said: '7시에 끝나', saidKana: '', lines: [{ label: '기본', text: '7시에 끝나요', kana: '', meaning: '', why: '' }], note: '' };
    expect(validateWrite(bad, andy)).toBe('lines');
    const line = { ...bad.lines[0], text: '7時に終わるよ' };
    expect(validateWrite({ ...bad, lines: [line, line, line] }, andy)).toBeNull();
    expect(validateWrite({ ...bad, lines: [line] }, andy)).toBe('lines');
    expect(validateWrite({ ...bad, said: '7時に終わる', lines: [line, line, line] }, andy)).toBe('said');
  });
  it('does not throw away good answers (Codex review3 false positives)', () => {
    expect(cleanIn('「사랑해」って言って', 'ja')).toBe(true);
    expect(cleanIn('‘好き’라고 말해 줘', 'ko')).toBe(true);
    expect(cleanIn('ｗｗ', 'ja')).toBe(true);
    expect(cleanIn('😭', 'ko')).toBe(true);
    expect(cleanIn('「사랑해」', 'ja')).toBe(false);
    expect(worthAlt('会いたいよ', '会いたいな', '보고 싶어')).toBe(true);
    expect(worthAlt('전화할래?', '통화할래?', '電話する？')).toBe(true);
    expect(inferGenders({ ...andy, partnerCalls: '오빠/누나', meCalls: '' })).toEqual({ me: '', partner: '' });
  });
  it('lets the speaker mix languages but never the translation', () => {
    const base = { heard: true, lang: 'ko' as const, said: '오늘 すごく 피곤해', translation: '今日すごく疲れた', jaKana: '', alt: '', altKana: '', altMeaning: '', altWhy: '', note: '' };
    expect(validateTalk(base)).toBeNull();
    expect(validateTalk({ ...base, lang: 'ja', said: '今日すごく疲れた', translation: '오늘 本当 피곤해' })).toBe('translation');
    expect(validateTalk({ ...base, translation: '今日 ㅇㅇ 疲れた' })).toBe('translation');
  });
  it('flags a daily line in the learner\'s own language', () => {
    expect(validateDaily({ line: '보고 싶었어', meaning: '보고 싶었어', kana: '', note: '' }, andy)).toBe('line');
    expect(validateDaily({ line: '会いたかった', meaning: '보고 싶었어', kana: 'あいたかった', note: '' }, andy)).toBeNull();
  });
  it('checks talk answers, including stray characters of the other script', () => {
    const base = { heard: true, lang: 'ko' as const, said: '고마워', translation: 'ありがとう', jaKana: 'ありがとー', alt: '', altKana: '', altMeaning: '', altWhy: '', note: '' };
    expect(validateTalk(base)).toBeNull();
    expect(validateTalk({ ...base, translation: '고마워' })).toBe('translation');
    expect(validateTalk({ ...base, translation: 'それ まるで シ오리 じゃん' })).toBe('translation');
    expect(validateTalk({ ...base, translation: '「사랑해」って言って' })).toBeNull();
    expect(validateTalk({ ...base, translation: 'お疲れ様ㅠㅠ' })).toBeNull();
    expect(validateTalk({ ...base, heard: false, said: '' })).toBeNull();
  });
});
