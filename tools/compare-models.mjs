// Each model alone (no fallback) on the hardest tasks: validity + speed. Key from keychain, never printed.
//   node tools/compare-models.mjs [model ...]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const root = new URL('..', import.meta.url).pathname;
const cache = `${root}tools/.cache`;
const key = execFileSync('security', ['find-generic-password', '-a', 'duri', '-s', 'duri-gemini-key', '-w'], { encoding: 'utf8' }).trim();
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const g = await server.ssrLoadModule('/src/lib/gemini.ts');
const p = await server.ssrLoadModule('/src/lib/prompts.ts');
const store = await server.ssrLoadModule('/src/lib/store.ts');

const profile = { ...store.DEFAULT_PROFILE, myLang: 'ko', myName: 'Andy', partnerName: '시오리', startDate: '2026-03-14' };
const system = p.systemPrompt(profile, [{ id: '1', ko: '우리 라멘집', ja: 'いつものラーメン屋' }]);
const ko = readFileSync(`${cache}/ko.m4a`).toString('base64');

const tasks = [
  ['write', [{ text: p.writePrompt({ profile, turns: [], tone: 'sweet', text: '7시에 끝나. 끝나면 바로 갈게' }) }], p.WRITE_SCHEMA, (d) => p.validateWrite(d, profile), (d) => d.lines?.map((l) => l.text).join(' | ')],
  ['understand', [{ text: p.understandPrompt({ profile, turns: [], text: '今日何時に終わる？早く会いたいな' }) }], p.UNDERSTAND_SCHEMA, (d) => p.validateUnderstand(d, profile), (d) => `${d.translation} / ${d.replies?.map((r) => r.text).join(' | ')}`],
  ['audio-ko', [{ inlineData: { mimeType: 'audio/mp4', data: ko } }, { text: p.talkPrompt({ profile, turns: [], tone: 'natural' }) }], p.TALK_SCHEMA, p.validateTalk, (d) => `${d.said} → ${d.translation} [${d.koKana}] [${d.jaHangul}]`],
];

const wanted = process.argv.slice(2);
const specs = wanted.length ? g.MODELS.filter((m) => wanted.includes(m.id)) : g.MODELS;
const rows = [];
for (const spec of specs) {
  for (const [name, parts, schema, validate, show] of tasks) {
    const started = Date.now();
    try {
      const r = await g.callGemini({ key, system, parts, schema, validate, models: [spec], timeoutMs: 30000 });
      rows.push({ model: spec.id, task: name, ms: Date.now() - started, result: r.invalid ? `INVALID ${r.invalid}` : 'ok', sample: show(r.data) });
    } catch (e) {
      rows.push({ model: spec.id, task: name, ms: Date.now() - started, result: `ERR ${e.kind} ${e.status || ''}`, sample: '' });
    }
    console.log(JSON.stringify(rows[rows.length - 1]));
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
}
writeFileSync(`${cache}/compare-${Date.now()}.json`, JSON.stringify(rows, null, 2));
await server.close();
