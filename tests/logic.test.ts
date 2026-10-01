import { describe, expect, it } from 'vitest';
import { dictKeys, errorKey, makeT } from '../src/lib/i18n';
import {
  contextLines,
  daysTogether,
  systemPrompt,
  TALK_SCHEMA,
  talkPrompt,
  turnFromTalk,
  turnFromUnderstand,
  turnFromWrite,
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
  it('maps a Korean utterance', () => {
    const turn = turnFromTalk(
      { heard: true, lang: 'ko', said: '보고 싶었어', translation: '会いたかった', koKana: 'ポゴ シポッソ', jaHangul: '아이타캇타', alt: 'ずっと会いたかった', altReading: '즛토 아이타캇타', altMeaning: '계속 보고 싶었어', altWhy: '더 애틋해요', note: '' },
      meta,
    );
    expect(turn).toMatchObject({ lang: 'ko', ko: '보고 싶었어', ja: '会いたかった', koKana: 'ポゴ シポッソ', jaHangul: '아이타캇타' });
    expect(turn.alt?.text).toBe('ずっと会いたかった');
    expect(turn.note).toBeUndefined();
  });
  it('maps a Japanese utterance and drops an alt identical to the translation', () => {
    const turn = turnFromTalk(
      { heard: true, lang: 'ja', said: 'ありがとう', translation: '고마워', koKana: 'コマウォ', jaHangul: '아리가토ー', alt: '고마워!', altReading: '', altMeaning: '', altWhy: '', note: '' },
      meta,
    );
    expect(turn).toMatchObject({ lang: 'ja', ja: 'ありがとう', ko: '고마워' });
    expect(turn.alt).toBeUndefined();
  });
  it('maps a received message with replies', () => {
    const turn = turnFromUnderstand(
      { lang: 'ja', translation: '언제 와?', koKana: '', jaHangul: 'イツ クルノ', nuance: '기다리는 느낌', words: [{ w: 'いつ', r: '이츠', m: '언제' }], replies: [{ text: 'すぐ行く', reading: '스구 이쿠', meaning: '금방 갈게' }] },
      'いつ来るの？',
      { model: 'm', ms: 1, id: 'x', ts: 1 },
    );
    expect(turn).toMatchObject({ channel: 'msg-in', ja: 'いつ来るの？', ko: '언제 와?' });
    expect(turn.lines?.[0].text).toBe('すぐ行く');
  });
  it('maps an outgoing message for a Japanese user', () => {
    const turn = turnFromWrite(
      { said: '今日はありがとう', lines: [{ label: '基本', text: '오늘 고마워', reading: 'オヌㇽ コマウォ', meaning: '今日ありがとう', why: '' }], myKana: '쿄ー와 아리가토ー', note: '' },
      { profile: { ...andy, myLang: 'ja' }, input: 'text', model: 'm', ms: 1, id: 'y', ts: 1 },
    );
    expect(turn).toMatchObject({ lang: 'ja', ja: '今日はありがとう', ko: '오늘 고마워', koKana: 'オヌㇽ コマウォ', jaHangul: '쿄ー와 아리가토ー' });
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
  it('ignores broken links', () => {
    expect(readShareHash('#join=%%%')).toBeNull();
    expect(readShareHash('')).toBeNull();
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
    const backup = parseBackup(JSON.stringify({ app: 'duri-couple', turns: [{ id: 'a', ts: 2 }], phrases: [], glossary: [] }));
    expect(mergeById([{ id: 'b', ts: 1 }], backup.turns as any).map((x: any) => x.id)).toEqual(['b', 'a']);
    expect(() => parseBackup('{"app":"other"}')).toThrow();
  });
});
