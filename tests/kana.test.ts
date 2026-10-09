import { describe, expect, it } from 'vitest';
import { isKanaOnly, kanaToHangul, koreanToKatakana, tidyJapanese, tidyKorean } from '../src/lib/kana';

describe('Korean → katakana, with the sound changes a learner hears', () => {
  const cases: [string, string][] = [
    ['감사합니다', 'カㇺサハㇺニダ'],
    ['같이', 'カチ'],
    ['먹어요', 'モゴヨ'],
    ['오늘 너무 보고 싶었어', 'オヌㇽ ノム ポゴ シポッソ'],
    ['진짜 고마웠어', 'チンチャ コマウォッソ'],
    ['사랑해', 'サランヘ'],
    ['안녕하세요', 'アンニョンハセヨ'],
    ['괜찮아', 'クェンチャナ'],
    ['좋아', 'チョア'],
    ['좋고', 'チョコ'],
    ['학교', 'ハㇰキョ'],
    ['읽어', 'イㇽゴ'],
    ['맛있어', 'マシッソ'],
    ['없어', 'オㇷ゚ソ'],
    ['축하해', 'チュカヘ'],
    ['신라', 'シㇽラ'],
    ['종로', 'チョンノ'],
    ['밥 먹었어?', 'パㇺ モゴッソ?'],
    ['못 먹어', 'モン モゴ'],
    ['못 해', 'モ テ'],
    ['꼭 해', 'コ ケ'],
    ['닫히다', 'タチダ'],
    ['할게', 'ハㇽケ'],
    ['전화할게요', 'チョンファハㇽケヨ'],
    ['갈거야', 'カㇽコヤ'],
    ['그럴걸', 'クロㇽコㇽ'],
    ['잘 자, 내일 봐', 'チャㇽ チャ, ネイㇽ プァ'],
    // Codex review2 word list (2026-10-10): verb stems, compounds, words no rule predicts
    ['읽고', 'イㇽコ'],
    ['맑게', 'マㇽケ'],
    ['닭고기', 'タㇰコギ'],
    ['넓다', 'ノㇽタ'],
    ['밟다', 'パㇷ゚タ'],
    ['밟아', 'パㇽバ'],
    ['밟히다', 'パㇽピダ'],
    ['앉히다', 'アンチダ'],
    ['깻잎이', 'ケンニピ'],
    ['꽃잎', 'コンニㇷ゚'],
    ['못 잊어', 'モン ニジョ'],
    ['색연필', 'センニョンピㇽ'],
    ['맛없어', 'マドㇷ゚ソ'],
    ['값없다', 'カボㇷ゚タ'],
    ['김밥', 'キㇺパㇷ゚'],
    ['여권', 'ヨックォン'],
    ['무슨 일 있어?', 'ムスン ニㇽ イッソ?'],
    ['할 일이 많아', 'ハㇽ リリ マナ'],
    ['일본 갈 일본어', 'イㇽボン カㇽ イㇽボノ'],
    ['서울역에서 만나', 'ソウㇽリョゲソ マンナ'],
    ['명동역', 'ミョンドンニョㇰ'],
    ['번역', 'ポニョㇰ'],
    ['여덟', 'ヨドㇽ'],
    ['시오리', 'シオリ'],
    ['우리 라멘집', 'ウリ ラメンジㇷ゚'],
    ['보고 싶어서 잠이 안 와 🥺', 'ポゴ シポソ チャミ アン ワ 🥺'],
    ['헐 대박 ㅋㅋㅋ', 'ホㇽ テバㇰ ククク'],
    ['최고', 'チェゴ'],
    ['의자', 'ウィジャ'],
    ['화이팅', 'ファイティン'],
  ];
  for (const [ko, kana] of cases) it(`${ko} → ${kana}`, () => expect(koreanToKatakana(ko)).toBe(kana));
});

describe('Japanese pronunciation kana → hangul', () => {
  const cases: [string, string][] = [
    ['きょー わ ほんとーに ありがとー', '쿄오 와 혼토오니 아리가토오'],
    ['いって', '잇테'],
    ['さんぽ', '삼포'],
    ['げんき', '겡키'],
    ['しんぶん', '심분'],
    ['あいたかった', '아이타캇타'],
    ['ちょっと', '촛토'],
    ['いつもの らーめんや', '이츠모노 라아멘야'],
    ['がっこー', '각코오'],
    ['いっぱい', '입파이'],
    ['おっぱ、 でんわ できる', '오빠, 덴와 데키루'],
    ['えーが', '에에가'],
    ['しゅーまつ', '슈우마츠'],
    ['シオリ', '시오리'],
    ['ふぁいと', '화이토'],
    ['まんなか', '만나카'],
    ['ほん。', '혼.'],
    ['ばか っ', '바카'],
  ];
  for (const [kana, ko] of cases) it(`${kana} → ${ko}`, () => expect(kanaToHangul(kana)).toBe(ko));
  it('only converts kana', () => {
    expect(isKanaOnly('きょーわ')).toBe(true);
    expect(isKanaOnly('きょーわ、たのしかった！')).toBe(true);
    expect(isKanaOnly('arigatou ありがとー')).toBe(false);
    // Real answer, 2026-10-10: an emoji inside the kana must not cost the whole reading.
    expect(isKanaOnly('しおり きょーわ いろいろ おつかれさま 😭 はやく やすんでね')).toBe(true);
    expect(isKanaOnly('えっ まじ ｗｗ')).toBe(true);
    expect(kanaToHangul('えっ まじ ｗｗ')).toBe('에 마지 ㅋㅋ');
    expect(isKanaOnly('今日わ')).toBe(false);
    expect(isKanaOnly('쿄ー')).toBe(false);
    expect(isKanaOnly('')).toBe(false);
  });
});

describe('chat habits across languages', () => {
  it('turns Korean laughter and tears into Japanese ones', () => {
    expect(tidyJapanese('お疲れ様ㅠㅠ 早く休んで')).toBe('お疲れ様😭 早く休んで');
    expect(tidyJapanese('やばㅋㅋㅋ')).toBe('やばｗｗ');
  });
  it('turns Japanese laughter into Korean ones', () => {
    expect(tidyKorean('또 늦잠 잔 거야? (笑)')).toBe('또 늦잠 잔 거야? ㅋㅋ');
    expect(tidyKorean('완전 웃겨 www')).toBe('완전 웃겨 ㅋㅋ');
  });
});
