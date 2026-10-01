// Real Gemini check using the app's own code. The key is read from the macOS keychain
// (service "duri-gemini-key", account "duri") and is never printed or written anywhere.
//   security add-generic-password -a duri -s duri-gemini-key -U -w
//   node tools/live-check.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const root = new URL('..', import.meta.url).pathname;
const cache = `${root}tools/.cache`;
mkdirSync(cache, { recursive: true });

let key = '';
try {
  key = execFileSync('security', ['find-generic-password', '-a', 'duri', '-s', 'duri-gemini-key', '-w'], { encoding: 'utf8' }).trim();
} catch {
  console.error('No key in keychain. Run: security add-generic-password -a duri -s duri-gemini-key -U -w');
  process.exit(1);
}

function audio(name, voice, text) {
  const aiff = `${cache}/${name}.aiff`;
  const m4a = `${cache}/${name}.m4a`;
  execFileSync('say', ['-v', voice, '-o', aiff, text]);
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', aiff, m4a]);
  return { mime: 'audio/mp4', data: readFileSync(m4a).toString('base64'), bytes: readFileSync(m4a).length };
}

const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const g = await server.ssrLoadModule('/src/lib/gemini.ts');
const p = await server.ssrLoadModule('/src/lib/prompts.ts');
const store = await server.ssrLoadModule('/src/lib/store.ts');

const profile = { ...store.DEFAULT_PROFILE, myLang: 'ko', myName: 'Andy', partnerName: '시오리', startDate: '2026-03-14', meCalls: '시오리', partnerCalls: 'オッパ' };
const glossary = [{ id: '1', ko: '우리 라멘집', ja: 'いつものラーメン屋', note: '단골 가게' }];
const system = p.systemPrompt(profile, glossary);
const report = [];
const log = (title, value) => {
  report.push({ title, value });
  console.log(`\n=== ${title}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);
};

// 1) which models answer at all
for (const spec of g.MODELS) log(`probe ${spec.id}`, await g.probeModel(key, spec));

const call = async (title, parts, schema, timeoutMs = 30000) => {
  const started = Date.now();
  try {
    const result = await g.callGemini({ key, system, parts, schema, timeoutMs });
    log(`${title} · ${result.model} · ${Date.now() - started}ms`, result.data);
    return result.data;
  } catch (error) {
    log(`${title} · FAILED`, { kind: error.kind, status: error.status, detail: error.detail });
    return null;
  }
};

// 2) typed text, both directions, with context and the couple dictionary
const t1 = await call('text ko→ja', [{ text: p.talkPrompt({ profile, turns: [], tone: 'sweet', text: '오늘 우리 라멘집 갈래? 너무 보고 싶어' }) }], p.TALK_SCHEMA);
const turns = t1 ? [p.turnFromTalk(t1, { input: 'text', model: '', ms: 0, id: 'a', ts: Date.now() - 60000 })] : [];
await call('text ja→ko (with context)', [{ text: p.talkPrompt({ profile, turns, tone: 'natural', text: 'いいよ！でも今日はちょっと遅くなるかも' }) }], p.TALK_SCHEMA);

// 3) real audio in the same container iPhone Safari records (AAC in MP4)
const ko = audio('ko', 'Yuna', '오늘 진짜 고마웠어. 다음 주에 또 만나자');
const ja = audio('ja', 'Kyoko', '今日は本当に楽しかった。また来週会おうね');
log('audio sizes', { ko: ko.bytes, ja: ja.bytes });
await call('audio ko', [{ inlineData: { mimeType: ko.mime, data: ko.data } }, { text: p.talkPrompt({ profile, turns: [], tone: 'natural' }) }], p.TALK_SCHEMA);
await call('audio ja', [{ inlineData: { mimeType: ja.mime, data: ja.data } }, { text: p.talkPrompt({ profile, turns: [], tone: 'natural' }) }], p.TALK_SCHEMA);

// 4) message helpers, pronunciation and daily line
await call('understand', [{ text: p.understandPrompt({ profile, turns: [], text: '今日何時に終わる？早く会いたいな' }) }], p.UNDERSTAND_SCHEMA);
await call('write', [{ text: p.writePrompt({ profile, turns: [], tone: 'sweet', text: '7시에 끝나. 끝나면 바로 갈게' }) }], p.WRITE_SCHEMA);
await call('pronounce', [{ inlineData: { mimeType: ja.mime, data: ja.data } }, { text: p.pronouncePrompt({ profile, target: '今日は本当に楽しかった。また来週会おうね', targetLang: 'ja', reading: '' }) }], p.PRONOUNCE_SCHEMA);
await call('daily', [{ text: p.dailyPrompt({ profile, turns, known: [], today: new Date() }) }], p.DAILY_SCHEMA);

log('attempt log', g.recentLog());
writeFileSync(`${cache}/live-report.json`, JSON.stringify(report, null, 2));
await server.close();
