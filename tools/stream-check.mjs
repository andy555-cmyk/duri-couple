// The app's own streaming path (callGemini + onPartial) against the real API. Key from keychain, never printed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const root = new URL('..', import.meta.url).pathname;
const key = execFileSync('security', ['find-generic-password', '-a', 'duri', '-s', 'duri-gemini-key', '-w'], { encoding: 'utf8' }).trim();
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const g = await server.ssrLoadModule('/src/lib/gemini.ts');
const p = await server.ssrLoadModule('/src/lib/prompts.ts');
const partial = await server.ssrLoadModule('/src/lib/partial.ts');
const store = await server.ssrLoadModule('/src/lib/store.ts');
const profile = { ...store.DEFAULT_PROFILE, myLang: 'ko', myName: 'Andy', partnerName: '시오리' };
const system = p.systemPrompt(profile, []);
const ko = readFileSync(`${root}tools/.cache/ko.m4a`).toString('base64');

for (const [name, parts] of [
  ['text', [{ text: p.talkPrompt({ profile, turns: [], tone: 'sweet', text: '내일 몇 시에 만날까? 보고 싶어' }) }]],
  ['audio', [{ inlineData: { mimeType: 'audio/mp4', data: ko } }, { text: p.talkPrompt({ profile, turns: [], tone: 'natural' }) }]],
]) {
  const t0 = Date.now();
  let first = 0, translationAt = 0, updates = 0, model = '';
  const result = await g.callGemini({
    key, system, parts, schema: p.TALK_SCHEMA, validate: p.validateTalk, hedgeMs: 4500, timeoutMs: 30000,
    onPartial: (pp, m) => {
      updates++; model = m;
      if (!first) first = Date.now() - t0;
      if (!translationAt && partial.fieldDone(pp, 'translation')) translationAt = Date.now() - t0;
    },
  });
  console.log(JSON.stringify({ name, model: result.model, firstMs: first, translationMs: translationAt, totalMs: Date.now() - t0, updates, invalid: result.invalid || null, said: result.data.said, translation: result.data.translation, koKana: result.data.koKana, jaHangul: result.data.jaHangul }));
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(JSON.stringify(g.recentLog().slice(0, 6)));
await server.close();
