/** Dev-only fake Gemini, used when the key is literally "mock". Never shipped: guarded by import.meta.env.DEV. */
const hasHangul = (s: string) => /[가-힣]/.test(s);

const SAMPLES = {
  ko: { said: '오늘 너무 보고 싶었어', translation: '今日すごく会いたかった', jaKana: 'きょー すごく あいたかった', alt: '今日ずっと会いたくてたまらなかった', altKana: 'きょー ずっと あいたくて たまらなかった', altMeaning: '오늘 내내 보고 싶어서 견딜 수 없었어', altWhy: '「たまらない」를 쓰면 애틋함이 더 살아나요.', note: '' },
  ja: { said: '今日はありがとう、楽しかった', translation: '오늘 고마워, 즐거웠어', jaKana: 'きょーわ ありがとー たのしかった', alt: '오늘 진짜 고마워, 너무 즐거웠어', altKana: '', altMeaning: '今日本当にありがとう、すごく楽しかった', altWhy: '「진짜」を入れると気持ちがもっと伝わります。', note: '' },
};

function answer(prompt: string, hasAudio: boolean) {
  if (prompt.includes('Return {"ok": true}')) return { ok: true };
  if (prompt.includes('- replies:')) {
    return {
      lang: 'ja',
      translation: '오늘 언제 끝나? 빨리 보고 싶어',
      jaKana: 'きょー なんじに おわる はやく あいたいな',
      nuance: '빨리 만나고 싶어서 살짝 조르는 느낌이에요. 귀엽게 받아 주면 좋아요.',
      words: [
        { w: '終わる', kana: 'おわる', m: '끝나다' },
        { w: '早く', kana: 'はやく', m: '빨리' },
      ],
      replies: [
        { text: '7時には終わるよ！すぐ会いに行くね', kana: 'しちじにわ おわるよ すぐ あいに いくね', meaning: '7시엔 끝나! 바로 보러 갈게' },
        { text: '俺も早く会いたいよ〜', kana: 'おれも はやく あいたいよー', meaning: '나도 빨리 보고 싶어~' },
        { text: 'もうすぐ！待ってて', kana: 'もー すぐ まってて', meaning: '곧 끝나! 기다려 줘' },
      ],
    };
  }
  if (prompt.includes('- lines:')) {
    return {
      said: '오늘 일찍 자, 내일 일찍 일어나야 하잖아',
      lines: [
        { label: '기본', text: '今日は早く寝てね、明日早いでしょ', kana: 'きょーわ はやく ねてね あした はやいでしょ', meaning: '오늘은 일찍 자, 내일 일찍이잖아', why: '걱정해 주는 느낌이 자연스러워요.' },
        { label: '다정하게', text: '明日早いんだから、今日はゆっくり休んでね。おやすみ', kana: 'あした はやいんだから きょーわ ゆっくり やすんでね おやすみ', meaning: '내일 일찍이니까 오늘은 푹 쉬어. 잘 자', why: '「ゆっくり休んで」는 연인 사이에 자주 써요.' },
        { label: '짧게', text: '早く寝なよ〜', kana: 'はやく ねなよー', meaning: '빨리 자~', why: '' },
      ],
      saidKana: '',
      note: '',
    };
  }
  if (prompt.includes('- score:')) {
    return { heard: '今日すごく会いたかった', score: 4, good: '「すごく」 발음이 아주 자연스러워요!', tip: '「会いたかった(아이타캇타)」의 「っ」를 한 박자 쉬어 주세요.' };
  }
  if (prompt.includes('learn today')) {
    return { line: '気をつけて帰ってね', meaning: '조심해서 들어가', kana: 'きお つけて かえってね', note: '헤어질 때나 통화 끝낼 때 쓰면 좋아요.' };
  }
  if (prompt.includes('Fill in the missing side')) return { ko: '시오리', ja: 'しおり' };
  const text = prompt.match(/«([^»]*)»/)?.[1];
  if (text != null) {
    const ko = hasHangul(text);
    const base = ko ? SAMPLES.ko : SAMPLES.ja;
    return { heard: true, lang: ko ? 'ko' : 'ja', ...base, said: text };
  }
  return { heard: true, lang: hasAudio ? 'ko' : 'ja', ...SAMPLES.ko };
}

export const mockFetch = (async (url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  const parts: any[] = body.contents?.[0]?.parts || [];
  const prompt = parts.map((p) => p.text || '').join('\n');
  const hasAudio = parts.some((p) => p.inlineData);
  const signal = init.signal as AbortSignal | undefined;
  const text = JSON.stringify(answer(prompt, hasAudio));
  const wait = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  if (!String(url).includes('streamGenerateContent')) {
    await wait(hasAudio ? 1400 : 700);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  // Same shape as the real server-sent events: a first-word delay, then small pieces.
  const encoder = new TextEncoder();
  const pieces = text.match(/[\s\S]{1,14}/g) || [];
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await wait(hasAudio ? 900 : 500);
        for (let i = 0; i < pieces.length; i++) {
          const last = i === pieces.length - 1;
          const event = { candidates: [{ content: { parts: [{ text: pieces[i] }] }, ...(last ? { finishReason: 'STOP' } : {}) }] };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`));
          await wait(35);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}) as unknown as typeof fetch;

/** Dev-only stand-in for a live session: scripted exchanges, alternating Korean and Japanese. */
export function runLiveMock(handle: (content: any) => void, level: (v: number) => void, ready: () => void) {
  const script = [
    ['오늘 진짜 고마웠어. ', '다음 주에 또 만나자.', '今日は本当にありがとう。', 'また来週会おうね。'],
    ['今日は本当に', '楽しかった。', '오늘 진짜 ', '즐거웠어.'],
  ];
  let stopped = false;
  const timers: number[] = [];
  const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(() => !stopped && fn(), ms));
  at(400, ready);
  let t = 900;
  for (let round = 0; round < 6; round++) {
    const [in1, in2, out1, out2] = script[round % 2];
    for (let k = 0; k < 12; k++) at(t + k * 120, () => level(0.25 + Math.random() * 0.5));
    at(t + 300, () => handle({ inputTranscription: { text: in1 } }));
    at(t + 900, () => handle({ inputTranscription: { text: in2 } }));
    at(t + 1500, () => level(0));
    at(t + 2500, () => handle({ outputTranscription: { text: out1 } }));
    at(t + 2900, () => handle({ outputTranscription: { text: out2 }, turnComplete: true }));
    t += 5200;
  }
  return () => {
    stopped = true;
    timers.forEach((id) => clearTimeout(id));
  };
}
