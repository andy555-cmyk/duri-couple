/** Dev-only fake Gemini, used when the key is literally "mock". Never shipped: guarded by import.meta.env.DEV. */
const hasHangul = (s: string) => /[가-힣]/.test(s);

const SAMPLES = {
  ko: { said: '오늘 너무 보고 싶었어', translation: '今日すごく会いたかった', koKana: 'オヌㇽ ノム ポゴ シポッソ', jaHangul: '쿄ー 스고쿠 아이타캇타', alt: '今日ずっと会いたくてたまらなかった', altReading: '쿄ー 즛토 아이타쿠테 타마라나캇타', altMeaning: '오늘 내내 보고 싶어서 견딜 수 없었어', altWhy: '「たまらない」를 쓰면 애틋함이 더 살아나요.', note: '' },
  ja: { said: '今日はありがとう、楽しかった', translation: '오늘 고마워, 즐거웠어', koKana: 'オヌㇽ コマウォ、チュㇽゴウォッソ', jaHangul: '쿄ー와 아리가토ー, 타노시캇타', alt: '오늘 진짜 고마워, 너무 즐거웠어', altReading: 'オヌㇽ チンッチャ コマウォ、ノム チュㇽゴウォッソ', altMeaning: '今日本当にありがとう、すごく楽しかった', altWhy: '「진짜」を入れると気持ちがもっと伝わります。', note: '' },
};

function answer(prompt: string, hasAudio: boolean) {
  if (prompt.includes('Return {"ok": true}')) return { ok: true };
  if (prompt.includes('- replies:')) {
    return {
      lang: 'ja',
      translation: '오늘 언제 끝나? 빨리 보고 싶어',
      koKana: 'オヌㇽ オンジェ ックンナ？ ッパㇽリ ポゴ シポ',
      jaHangul: '쿄ー 난지니 오와루? 하야쿠 아이타이나',
      nuance: '빨리 만나고 싶어서 살짝 조르는 느낌이에요. 귀엽게 받아 주면 좋아요.',
      words: [
        { w: '終わる', r: '오와루', m: '끝나다' },
        { w: '早く', r: '하야쿠', m: '빨리' },
      ],
      replies: [
        { text: '7時には終わるよ！すぐ会いに行くね', reading: '시치지니와 오와루요! 스구 아이니 이쿠네', meaning: '7시엔 끝나! 바로 보러 갈게' },
        { text: '俺も早く会いたいよ〜', reading: '오레모 하야쿠 아이타이요ー', meaning: '나도 빨리 보고 싶어~' },
        { text: 'もうすぐ！待ってて', reading: '모ー 스구! 맛테테', meaning: '곧 끝나! 기다려 줘' },
      ],
    };
  }
  if (prompt.includes('- lines:')) {
    return {
      said: '오늘 일찍 자, 내일 일찍 일어나야 하잖아',
      lines: [
        { label: '기본', text: '今日は早く寝てね、明日早いでしょ', reading: '쿄ー와 하야쿠 네테네, 아시타 하야이데쇼', meaning: '오늘은 일찍 자, 내일 일찍이잖아', why: '걱정해 주는 느낌이 자연스러워요.' },
        { label: '다정하게', text: '明日早いんだから、今日はゆっくり休んでね。おやすみ', reading: '아시타 하야인다카라, 쿄ー와 윳쿠리 야슨데네. 오야스미', meaning: '내일 일찍이니까 오늘은 푹 쉬어. 잘 자', why: '「ゆっくり休んで」는 연인 사이에 자주 써요.' },
        { label: '짧게', text: '早く寝なよ〜', reading: '하야쿠 네나요ー', meaning: '빨리 자~', why: '' },
      ],
      myKana: 'オヌㇽ イㇽッチㇰ チャ',
      note: '',
    };
  }
  if (prompt.includes('- score:')) {
    return { heard: '今日すごく会いたかった', score: 4, good: '「すごく」 발음이 아주 자연스러워요!', tip: '「会いたかった(아이타캇타)」의 「っ」를 한 박자 쉬어 주세요.' };
  }
  if (prompt.includes('learn today')) {
    return { line: '気をつけて帰ってね', meaning: '조심해서 들어가', koKana: 'チョシㇺヘソ トゥロガ', jaHangul: '키오 츠케테 카엣테네', note: '헤어질 때나 통화 끝낼 때 쓰면 좋아요.' };
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

export const mockFetch = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  const parts: any[] = body.contents?.[0]?.parts || [];
  const prompt = parts.map((p) => p.text || '').join('\n');
  const hasAudio = parts.some((p) => p.inlineData);
  await new Promise((resolve) => setTimeout(resolve, hasAudio ? 1400 : 700));
  if ((init.signal as AbortSignal | undefined)?.aborted) throw new DOMException('aborted', 'AbortError');
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer(prompt, hasAudio)) }] }, finishReason: 'STOP' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as unknown as typeof fetch;
