// Latency benchmark against the real API. Key from keychain, never printed.
//   node tools/bench.mjs [rounds]
// For each model/thinking combo: plain call (total time + token usage) and a streamed call
// (time to first chunk, time until the "translation" field is complete).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const root = new URL('..', import.meta.url).pathname;
const cache = `${root}tools/.cache`;
const key = execFileSync('security', ['find-generic-password', '-a', 'duri', '-s', 'duri-gemini-key', '-w'], { encoding: 'utf8' }).trim();
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const p = await server.ssrLoadModule('/src/lib/prompts.ts');
const g = await server.ssrLoadModule('/src/lib/gemini.ts');
const store = await server.ssrLoadModule('/src/lib/store.ts');

const profile = { ...store.DEFAULT_PROFILE, myLang: 'ko', myName: 'Andy', partnerName: '시오리', startDate: '2026-03-14' };
const system = p.systemPrompt(profile, [{ id: '1', ko: '우리 라멘집', ja: 'いつものラーメン屋' }]);
const ko = readFileSync(`${cache}/ko.m4a`).toString('base64');
const inputs = {
  text: [{ text: p.talkPrompt({ profile, turns: [], tone: 'natural', text: '오늘 우리 라멘집 갈래? 너무 보고 싶어' }) }],
  audio: [{ inlineData: { mimeType: 'audio/mp4', data: ko } }, { text: p.talkPrompt({ profile, turns: [], tone: 'natural' }) }],
};
const combos = (process.env.COMBOS || 'gemini-3.5-flash:low,gemini-3.5-flash:minimal,gemini-3.6-flash:minimal,gemini-3.6-flash:low,gemini-3.5-flash-lite:minimal,gemini-3.8-flash:low')
  .split(',')
  .map((c) => c.split(':'));
const url = (model, stream) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
const body = (model, thinking, parts) =>
  JSON.stringify(g.buildBody({ system, parts, schema: p.TALK_SCHEMA, spec: { id: model, thinking }, lite: false, maxTokens: 4096, temperature: 0.4 }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function plain(model, thinking, parts) {
  const t0 = Date.now();
  const res = await fetch(url(model, false), { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: body(model, thinking, parts) });
  const json = await res.json();
  const ms = Date.now() - t0;
  if (!res.ok) return { ms, status: res.status, err: String(json?.error?.message || '').slice(0, 80) };
  const u = json.usageMetadata || {};
  return { ms, status: 200, prompt: u.promptTokenCount, thoughts: u.thoughtsTokenCount || 0, out: u.candidatesTokenCount, text: g.answerText(json).text.slice(0, 60) };
}

async function streamed(model, thinking, parts) {
  const t0 = Date.now();
  const res = await fetch(url(model, true), { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: body(model, thinking, parts) });
  if (!res.ok) return { status: res.status, err: (await res.text()).slice(0, 80) };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let first = 0;
  let translationDone = 0;
  let chunks = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    buf = buf.replace(/\r\n/g, '\n');
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = event.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const data = JSON.parse(line.slice(5));
      const piece = (data.candidates?.[0]?.content?.parts || []).filter((x) => !x.thought && typeof x.text === 'string').map((x) => x.text).join('');
      if (piece) {
        chunks++;
        if (!first) first = Date.now() - t0;
        text += piece;
        if (!translationDone && /"translation"\s*:\s*"(?:[^"\\]|\\.)*"/.test(text)) translationDone = Date.now() - t0;
      }
    }
  }
  return { status: 200, firstChunk: first, translationReady: translationDone, total: Date.now() - t0, chunks };
}

const rounds = Number(process.argv[2] || 1);
const rows = [];
for (let r = 0; r < rounds; r++) {
  for (const [model, thinking] of combos) {
    for (const [kind, parts] of Object.entries(inputs)) {
      const a = await plain(model, thinking, parts).catch((e) => ({ err: String(e).slice(0, 80) }));
      await sleep(2500);
      const b = await streamed(model, thinking, parts).catch((e) => ({ err: String(e).slice(0, 80) }));
      const row = { model: model.replace('gemini-', ''), thinking, kind, ...a, stream: b };
      rows.push(row);
      console.log(JSON.stringify(row));
      await sleep(2500);
    }
  }
}
writeFileSync(`${cache}/bench-${Date.now()}.json`, JSON.stringify(rows, null, 2));
await server.close();
