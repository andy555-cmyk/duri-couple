// Runs a couple-style test set through the real pipeline and saves the answers for an independent grader.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const root = new URL('..', import.meta.url).pathname;
const key = execFileSync('security', ['find-generic-password', '-a', 'duri', '-s', 'duri-gemini-key', '-w'], { encoding: 'utf8' }).trim();
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const g = await server.ssrLoadModule('/src/lib/gemini.ts');
const p = await server.ssrLoadModule('/src/lib/prompts.ts');
const store = await server.ssrLoadModule('/src/lib/store.ts');
const profile = { ...store.DEFAULT_PROFILE, myLang: 'ko', myName: 'Andy', partnerName: '시오리', meCalls: '시오리', partnerCalls: 'オッパ', startDate: '2026-03-14' };
const glossary = [{ id: '1', ko: '우리 라멘집', ja: 'いつものラーメン屋', note: '단골' }];
const system = p.systemPrompt(profile, glossary);
const set = [
  ['ko', 'sweet', '자기야 오늘 진짜 수고 많았어ㅠㅠ 얼른 쉬어'],
  ['ko', 'playful', '헐 대박 ㅋㅋㅋ 그거 완전 너잖아'],
  ['ko', 'natural', '이번 주말에 우리 라멘집 갈래? 내가 쏠게'],
  ['ko', 'serious', '어제 내가 말 심하게 한 거 미안해. 진심 아니었어'],
  ['ko', 'sweet', '보고 싶어서 잠이 안 와 🥺'],
  ['ko', 'natural', '시오리 엄마한테 선물 뭐 사가면 좋을까?'],
  ['ja', 'natural', 'オッパ、今日ちょっと疲れちゃった…電話できる？'],
  ['ja', 'playful', 'えー、また寝坊したの？笑'],
  ['ja', 'sweet', '会えてほんとに嬉しかった。また来週ね💕'],
  ['ja', 'serious', 'この前のこと、まだちょっと気にしてる'],
  ['ja', 'natural', '週末は雨っぽいから、家で映画でも観ようか'],
  ['ja', 'natural', 'いつものラーメン屋、今日休みだって😭'],
];
const out = [];
for (const [lang, tone, text] of set) {
  const t0 = Date.now();
  try {
    const r = await g.callGemini({ key, system, parts: [{ text: p.talkPrompt({ profile, turns: [], tone, text }) }], schema: p.TALK_SCHEMA, validate: p.validateTalk, onPartial: () => {}, timeoutMs: 25000 });
    const ms = Date.now() - t0;
    const turn = p.turnFromTalk(r.data, { input: 'text', model: r.model, ms, id: 'q', ts: Date.now() });
    // What the screen shows: Korean reading made by rule, Japanese reading from the model's kana.
    const shown = { ko: turn.ko, ja: turn.ja, koKana: turn.koKana, jaHangul: turn.jaHangul, alt: turn.alt || null, note: turn.note || null };
    out.push({ input: text, inputLang: lang, tone, model: r.model, ms, invalid: r.invalid || null, shown, raw: r.data });
  } catch (e) {
    out.push({ input: text, inputLang: lang, tone, error: `${e.kind} ${e.status || ''}` });
  }
  console.log(JSON.stringify(out[out.length - 1]).slice(0, 220));
  await new Promise((r) => setTimeout(r, Number(process.env.GAP_MS || 12000)));
}
writeFileSync(`${process.env.HOME}/dev/duri-lab/quality/${process.env.OUT || 'answers.json'}`, JSON.stringify({ profile: { ko: 'Andy (Korean)', ja: '시오리/しおり (Japanese)', register: 'casual between lovers', nicknames: 'Andy calls her 시오리; she calls him オッパ', dictionary: '우리 라멘집 = いつものラーメン屋' }, answers: out }, null, 2));
await server.close();
