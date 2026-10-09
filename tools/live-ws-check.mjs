// Drives the app's own LiveInterpreter against the real Gemini Live API from Node (no mic, no speaker):
// connects, streams a 16 kHz speech file in 100 ms chunks at real-time pace, then silence, and prints
// the states, captions and finished turns with timings. The key comes from the macOS keychain and is
// never printed.
//   node tools/live-ws-check.mjs [ko|ja|both]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

globalThis.window ??= globalThis;
const root = new URL('..', import.meta.url).pathname;
const key = execFileSync('security', ['find-generic-password', '-a', 'duri', '-s', 'duri-gemini-key', '-w'], { encoding: 'utf8' }).trim();
const server = await createServer({ root, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
const { LiveInterpreter } = await server.ssrLoadModule('/src/lib/live.ts');
const p = await server.ssrLoadModule('/src/lib/prompts.ts');
const store = await server.ssrLoadModule('/src/lib/store.ts');
const profile = { ...store.DEFAULT_PROFILE, myLang: 'ko', myName: 'Andy', partnerName: '시오리', meCalls: '시오리', partnerCalls: 'オッパ' };
const glossary = [{ id: '1', ko: '우리 라멘집', ja: 'いつものラーメン屋' }];

function pcmOf(path) {
  const buf = readFileSync(path);
  const at = buf.indexOf('data') + 8; // plain 16-bit mono WAV
  return buf.subarray(at);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rmsOf = (ab) => {
  const v = new Int16Array(ab);
  let sum = 0;
  for (const x of v) sum += (x / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, v.length));
};
const quiet = () => {
  const ab = new Int16Array(1600).buffer;
  live.feed(ab, 0.002);
};
const which = process.argv[2] || 'both';
const files = { ko: `${process.env.HOME}/dev/duri-lab/live/ko-16k-pcm.wav`, ja: `${process.env.HOME}/dev/duri-lab/live/ja-16k-pcm.wav` };
const order = which === 'both' ? ['ko', 'ja'] : [which];

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
const turns = [];
let state = '';
let heardAt = 0;
const gapMs = Number(process.env.GAP_MS || 2000);
const live = new LiveInterpreter(
  { key, system: p.livePrompt(profile, glossary), speak: false, endMs: Number(process.env.END_MS || 700) },
  {
    onState: (s, f) => {
      state = s;
      console.log(at(), 'state', s, f || '');
    },
    onCaption: (c) => {
      if (c.input && !heardAt) {
        heardAt = Date.now();
        console.log(at(), 'first input transcript', JSON.stringify(c.input.slice(0, 20)));
      }
      if (!c.input) heardAt = 0;
    },
    onTurn: (t) => {
      turns.push({ ...t, at: Date.now() });
      console.log(at(), 'TURN', JSON.stringify(t));
    },
  },
);
live.connect();
for (let i = 0; i < 100 && state !== 'listening'; i++) await sleep(100);
if (state !== 'listening') {
  console.log('never reached listening:', state);
  process.exit(1);
}
for (const [n, lang] of order.entries()) {
  // People pause before answering: a second utterance follows after GAP_MS of silence.
  if (n > 0) for (let i = 0; i < gapMs / 100; i++) {
    quiet();
    await sleep(100);
  }
  const pcm = pcmOf(files[lang]);
  const chunk = 3200; // 100 ms of 16 kHz PCM16
  for (let i = 0; i < pcm.length; i += chunk) {
    const piece = pcm.subarray(i, i + chunk);
    const ab = piece.buffer.slice(piece.byteOffset, piece.byteOffset + piece.byteLength);
    live.feed(ab, rmsOf(ab));
    await sleep(100);
  }
  const spokeEnd = Date.now();
  console.log(at(), `sent ${lang} speech`);
  if (process.env.NO_WAIT && n < order.length - 1) {
    // The next person starts right after this one (0.8 s), before this translation is done.
    for (let i = 0; i < 8; i++) {
      quiet();
      await sleep(100);
    }
    continue;
  }
  const before = turns.length;
  for (let i = 0; i < 80 && turns.length === before; i++) {
    quiet();
    await sleep(100);
  }
  const turn = turns[before];
  console.log(turn ? `${lang}: translation ${((turn.at - spokeEnd) / 1000).toFixed(2)}s after speech ended` : `${lang}: no turn`);
}
if (process.env.NO_WAIT) {
  for (let i = 0; i < 100 && turns.length < order.length; i++) {
    quiet();
    await sleep(100);
  }
  console.log(`turns: ${turns.length} of ${order.length}`);
}
await live.stop();
console.log(at(), 'stopped, state', state);
await server.close();
process.exit(0);
