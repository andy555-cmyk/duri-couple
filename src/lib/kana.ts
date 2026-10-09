/**
 * Pronunciation guides written by code, not by the model.
 *
 * Asking the model to transliterate across scripts was the least reliable part of every answer
 * (2026-10-09 test set: hangul leaked into katakana readings in 6 of 12 answers, so they were dropped).
 * - Korean → katakana is fully rule-based here: syllable decomposition plus the sound changes a
 *   learner hears (linking, nasalisation, ㅎ, palatalisation, tensing), in the style of Japanese
 *   Korean-learning books (small ㇰ ㇽ ㇺ ㇷ゚ for final consonants).
 * - Japanese → hangul needs the reading of each kanji, which only the model knows, so the model
 *   writes the pronunciation in hiragana (its strong suit) and this code turns kana into hangul.
 */

/* ---------------- Korean → katakana ---------------- */

const INITIALS = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const MEDIALS = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
const FINALS = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

interface Syl {
  i: string;
  m: string;
  f: string;
}

const isSyllable = (ch: string) => ch >= '가' && ch <= '힣';

function decompose(ch: string): Syl {
  const code = ch.charCodeAt(0) - 0xac00;
  return { i: INITIALS[Math.floor(code / 588)], m: MEDIALS[Math.floor((code % 588) / 28)], f: FINALS[code % 28] };
}

// Double finals: [stays, moves on linking]
const SPLIT: Record<string, [string, string]> = {
  ㄳ: ['ㄱ', 'ㅆ'],
  ㄵ: ['ㄴ', 'ㅈ'],
  ㄺ: ['ㄹ', 'ㄱ'],
  ㄻ: ['ㄹ', 'ㅁ'],
  ㄼ: ['ㄹ', 'ㅂ'],
  ㄽ: ['ㄹ', 'ㅆ'],
  ㄾ: ['ㄹ', 'ㅌ'],
  ㄿ: ['ㄹ', 'ㅍ'],
  ㅄ: ['ㅂ', 'ㅆ'],
};
const NEUTRAL: Record<string, string> = {
  ㄱ: 'ㄱ', ㄲ: 'ㄱ', ㅋ: 'ㄱ', ㄳ: 'ㄱ', ㄺ: 'ㄱ',
  ㄴ: 'ㄴ', ㄵ: 'ㄴ', ㄶ: 'ㄴ',
  ㄷ: 'ㄷ', ㅅ: 'ㄷ', ㅆ: 'ㄷ', ㅈ: 'ㄷ', ㅊ: 'ㄷ', ㅌ: 'ㄷ', ㅎ: 'ㄷ',
  ㄹ: 'ㄹ', ㄼ: 'ㄹ', ㄽ: 'ㄹ', ㄾ: 'ㄹ', ㅀ: 'ㄹ',
  ㅁ: 'ㅁ', ㄻ: 'ㅁ',
  ㅂ: 'ㅂ', ㅍ: 'ㅂ', ㅄ: 'ㅂ', ㄿ: 'ㅂ',
  ㅇ: 'ㅇ',
};
const ASPIRATE: Record<string, string> = { ㄱ: 'ㅋ', ㄷ: 'ㅌ', ㅂ: 'ㅍ', ㅈ: 'ㅊ' };
const TENSE: Record<string, string> = { ㄱ: 'ㄲ', ㄷ: 'ㄸ', ㅂ: 'ㅃ', ㅅ: 'ㅆ', ㅈ: 'ㅉ' };

/** ㄱ/ㄷ/ㅂ/ㅈ + ㅎ → ㅋ/ㅌ/ㅍ/ㅊ, and ㄷ + 히 → 치 (닫히다 → 다치다). Returns false when nothing applies. */
function aspirateInto(a: Syl, b: Syl): boolean {
  // Double finals give their second consonant to ㅎ: 밟히다 → 발피다, 앉히다 → 안치다, 읽히다 → 일키다.
  const split = SPLIT[a.f];
  if (split && ASPIRATE[split[1]]) {
    b.i = ASPIRATE[split[1]];
    a.f = split[0];
    return true;
  }
  const n = NEUTRAL[a.f];
  if (n !== 'ㄱ' && n !== 'ㄷ' && n !== 'ㅂ') return false;
  const base = SPLIT[a.f]?.[0];
  b.i = n === 'ㄱ' ? 'ㅋ' : n === 'ㅂ' ? 'ㅍ' : a.f === 'ㅈ' ? 'ㅊ' : 'ㅌ';
  if (b.i === 'ㅌ' && b.m === 'ㅣ' && (a.f === 'ㄷ' || a.f === 'ㅌ')) b.i = 'ㅊ';
  a.f = base && NEUTRAL[base] !== n ? base : '';
  return true;
}

const NASAL: Record<string, string> = { ㄱ: 'ㅇ', ㄷ: 'ㄴ', ㅂ: 'ㅁ' };
// Nouns ending in ㄺ (닭, 흙, 칡): ㄱ stays before ㄱ (닭고기 → 닥꼬기).
const NOUN_RG = new Set(['ㄷㅏ', 'ㅎㅡ', 'ㅊㅣ']);

/**
 * Words whose standard pronunciation no general rule predicts, written the way they sound so the
 * rules can take it from there (Codex review2 tested 96 words; these were the misses that matter in
 * a couple's chat): ㄴ added in compounds, tensing in compounds and Sino-Korean words, 맛없다.
 */
const SPOKEN_AS: [string, string][] = [
  ['깻잎', '깻닢'], ['꽃잎', '꽃닢'], ['한여름', '한녀름'], ['맨입', '맨닙'], ['솜이불', '솜니불'], ['막일', '막닐'],
  ['색연필', '색년필'], ['못잊', '못닞'], ['식용유', '식용뉴'], ['볼일', '볼릴'], ['큰일', '큰닐'], ['별일', '별릴'], ['집안일', '집안닐'],
  ['맛없', '맏없'], ['멋없', '먿없'], ['값없', '갑업'],
  ['김밥', '김빱'], ['비빔밥', '비빔빱'], ['볶음밥', '볶음빱'], ['덮밥', '덮빱'], ['술집', '술찝'], ['술잔', '술짠'],
  ['여권', '여꿘'], ['문법', '문뻡'], ['글자', '글짜'], ['인기', '인끼'], ['성격', '성껵'], ['물가', '물까'], ['사건', '사껀'], ['조건', '조껀'],
  ['손가락', '손까락'], ['발가락', '발까락'], ['눈길', '눈낄'], ['밤길', '밤낄'], ['산길', '산낄'], ['물고기', '물꼬기'],
];
const spokenAs = (word: string) => SPOKEN_AS.reduce((w, [from, to]) => (w.includes(from) ? w.split(from).join(to) : w), word);

/** 서울역 → 서울력, 부산역에서 → 부산녁에서: ㄴ is added before 역 after a place name (two or more syllables). */
function stationN(word: Syl[]) {
  for (let k = 2; k < word.length; k++) {
    const b = word[k];
    const a = word[k - 1];
    if (b.i === 'ㅇ' && b.m === 'ㅕ' && b.f === 'ㄱ' && a.f) b.i = a.f === 'ㄹ' ? 'ㄹ' : 'ㄴ';
  }
}

// 일 as "a matter" after a modifier: 무슨 일 → 무슨 닐, 할 일 → 할 릴 (일본, 일요일 are other words).
const MATTER = /^일(?:이|은|을|도|로|만|이야|이에요|이지|인데|이랑|이고|이라도|밖에|까지|부터|이니|이네|이래|이었어|이었는데|이었지)?$/;

/**
 * Sound changes that carry across a single space in connected speech:
 * 못 해 → 모 태, 밥 먹어 → 밤 머거, 꼭 해 → 꼬 캐.
 */
function joinWords(a: Syl, b: Syl, prevWord = '', nextWord = '') {
  if (!a.f) return;
  if ((a.f === 'ㄴ' || a.f === 'ㄹ') && MATTER.test(nextWord)) {
    b.i = a.f;
    return;
  }
  if (prevWord.endsWith('못') && nextWord.startsWith('잊')) b.i = 'ㄴ';
  if (b.i === 'ㅎ') {
    aspirateInto(a, b);
    return;
  }
  const n = NEUTRAL[a.f];
  if ((b.i === 'ㄴ' || b.i === 'ㅁ') && NASAL[n]) a.f = NASAL[n];
}

const isSyl = (x: Syl | undefined, i: string, m: string, f = '') => !!x && x.i === i && x.m === m && x.f === f;

/**
 * Tensing after the future-tense ㄹ in the endings couples use all the time:
 * 할게 → 할께, 할거야 → 할꺼야, 할걸 → 할껄. (An adverb like 길게 is tensed too — a small, rare miss.)
 */
function futureTense(s: Syl[], k: number): boolean {
  const b = s[k + 1];
  const after = s[k + 2];
  if (b.i !== 'ㄱ') return false;
  if (b.m === 'ㅓ' && (b.f === '' || b.f === 'ㄹ')) return true; // 거, 걸
  return b.m === 'ㅔ' && b.f === '' && (!after || isSyl(after, 'ㅇ', 'ㅛ')); // 게 / 게요 at the end
}

/** Applies the sound changes between neighbouring syllables of one word. */
export function pronounceKorean(word: Syl[]): Syl[] {
  const s = word.map((x) => ({ ...x }));
  for (let k = 0; k < s.length - 1; k++) {
    const a = s[k];
    const b = s[k + 1];
    // ㅎ at the end of a syllable
    if (a.f === 'ㅎ' || a.f === 'ㄶ' || a.f === 'ㅀ') {
      const rest = a.f === 'ㄶ' ? 'ㄴ' : a.f === 'ㅀ' ? 'ㄹ' : '';
      if (b.i === 'ㅇ') a.f = rest;
      else if (ASPIRATE[b.i]) {
        b.i = ASPIRATE[b.i];
        a.f = rest;
      } else if (b.i === 'ㅅ' && a.f === 'ㅎ') {
        b.i = 'ㅆ';
        a.f = '';
      } else if (b.i === 'ㄴ' && a.f === 'ㅎ') a.f = 'ㄴ';
    }
    // ㅎ at the start of the next syllable makes an obstruent aspirated
    if (b.i === 'ㅎ' && a.f) aspirateInto(a, b);
    // Linking: a final consonant moves onto a following vowel
    if (b.i === 'ㅇ' && a.f && a.f !== 'ㅇ') {
      const split = SPLIT[a.f];
      const moved = split ? split[1] : a.f;
      a.f = split ? split[0] : '';
      b.i = moved;
      // Palatalisation: ㄷ/ㅌ before 이 → ㅈ/ㅊ (같이 → 가치)
      if (b.m === 'ㅣ' && (b.i === 'ㄷ' || b.i === 'ㅌ')) b.i = b.i === 'ㄷ' ? 'ㅈ' : 'ㅊ';
      continue;
    }
    if (!a.f) continue;
    let n = NEUTRAL[a.f] || a.f;
    // Verb stems: ㄺ keeps ㄹ before ㄱ (읽고 → 일꼬, 맑게 → 말께; nouns 닭·흙 do not), 밟 keeps ㅂ (밟다 → 밥따),
    // and ㄼ/ㄾ tense what follows (넓다 → 널따).
    if (a.f === 'ㄺ' && b.i === 'ㄱ' && !NOUN_RG.has(a.i + a.m)) {
      n = 'ㄹ';
      b.i = 'ㄲ';
    } else if (a.f === 'ㄼ' && a.i === 'ㅂ' && a.m === 'ㅏ') n = 'ㅂ';
    else if ((a.f === 'ㄼ' || a.f === 'ㄾ') && TENSE[b.i]) b.i = TENSE[b.i];
    // ㄹ after ㅁ/ㅇ (or ㄱ/ㅂ) is read ㄴ
    if (b.i === 'ㄹ' && (n === 'ㅁ' || n === 'ㅇ' || n === 'ㄱ' || n === 'ㅂ')) b.i = 'ㄴ';
    // Nasalisation: ㄱ/ㄷ/ㅂ before ㄴ/ㅁ → ㅇ/ㄴ/ㅁ (합니다 → 함니다)
    if ((b.i === 'ㄴ' || b.i === 'ㅁ') && (n === 'ㄱ' || n === 'ㄷ' || n === 'ㅂ')) n = n === 'ㄱ' ? 'ㅇ' : n === 'ㄷ' ? 'ㄴ' : 'ㅁ';
    // Lateralisation: ㄴ+ㄹ / ㄹ+ㄴ → ㄹㄹ (신라 → 실라)
    if (n === 'ㄴ' && b.i === 'ㄹ') n = 'ㄹ';
    else if (n === 'ㄹ' && b.i === 'ㄴ') b.i = 'ㄹ';
    // Tensing after an obstruent (학교 → 학꾜)
    if ((n === 'ㄱ' || n === 'ㄷ' || n === 'ㅂ') && TENSE[b.i]) b.i = TENSE[b.i];
    else if (n === 'ㄹ' && futureTense(s, k)) b.i = 'ㄲ';
    a.f = n;
  }
  const last = s[s.length - 1];
  if (last && last.f) last.f = NEUTRAL[last.f] || last.f;
  return s;
}

// Vowel → [glide, base vowel]; base vowels index into each kana row (a i u e o).
const VOWEL: Record<string, [string, string]> = {
  ㅏ: ['', 'a'], ㅐ: ['', 'e'], ㅑ: ['y', 'a'], ㅒ: ['y', 'e'], ㅓ: ['', 'o'], ㅔ: ['', 'e'], ㅕ: ['y', 'o'], ㅖ: ['y', 'e'],
  ㅗ: ['', 'o'], ㅘ: ['w', 'a'], ㅙ: ['w', 'e'], ㅚ: ['w', 'e'], ㅛ: ['y', 'o'], ㅜ: ['', 'u'], ㅝ: ['w', 'o'], ㅞ: ['w', 'e'],
  ㅟ: ['w', 'i'], ㅠ: ['y', 'u'], ㅡ: ['', 'u'], ㅢ: ['', 'ui'], ㅣ: ['', 'i'],
};
const IDX: Record<string, number> = { a: 0, i: 1, u: 2, e: 3, o: 4 };
const ROWS: Record<string, string[]> = {
  '': ['ア', 'イ', 'ウ', 'エ', 'オ'],
  k: ['カ', 'キ', 'ク', 'ケ', 'コ'],
  g: ['ガ', 'ギ', 'グ', 'ゲ', 'ゴ'],
  s: ['サ', 'シ', 'ス', 'セ', 'ソ'],
  t: ['タ', 'ティ', 'トゥ', 'テ', 'ト'],
  d: ['ダ', 'ディ', 'ドゥ', 'デ', 'ド'],
  n: ['ナ', 'ニ', 'ヌ', 'ネ', 'ノ'],
  h: ['ハ', 'ヒ', 'フ', 'ヘ', 'ホ'],
  p: ['パ', 'ピ', 'プ', 'ペ', 'ポ'],
  b: ['バ', 'ビ', 'ブ', 'ベ', 'ボ'],
  m: ['マ', 'ミ', 'ム', 'メ', 'モ'],
  r: ['ラ', 'リ', 'ル', 'レ', 'ロ'],
  ch: ['チャ', 'チ', 'チュ', 'チェ', 'チョ'],
  j: ['ジャ', 'ジ', 'ジュ', 'ジェ', 'ジョ'],
};
const Y_SMALL: Record<string, string> = { a: 'ャ', u: 'ュ', o: 'ョ', e: 'ェ', i: '' };
const W_SMALL: Record<string, string> = { a: 'ァ', i: 'ィ', e: 'ェ', o: 'ォ', u: '' };
const FINAL_KANA: Record<string, string> = { ㄱ: 'ㇰ', ㄴ: 'ン', ㄷ: 'ㇳ', ㄹ: 'ㇽ', ㅁ: 'ㇺ', ㅂ: 'ㇷ゚', ㅇ: 'ン' };

function consonantRow(initial: string, voiced: boolean): { row: string; tense: boolean } {
  switch (initial) {
    case 'ㄱ':
      return { row: voiced ? 'g' : 'k', tense: false };
    case 'ㄷ':
      return { row: voiced ? 'd' : 't', tense: false };
    case 'ㅂ':
      return { row: voiced ? 'b' : 'p', tense: false };
    case 'ㅈ':
      return { row: voiced ? 'j' : 'ch', tense: false };
    case 'ㄲ':
      return { row: 'k', tense: true };
    case 'ㄸ':
      return { row: 't', tense: true };
    case 'ㅃ':
      return { row: 'p', tense: true };
    case 'ㅉ':
      return { row: 'ch', tense: true };
    case 'ㅆ':
      return { row: 's', tense: true };
    case 'ㅋ':
      return { row: 'k', tense: false };
    case 'ㅌ':
      return { row: 't', tense: false };
    case 'ㅍ':
      return { row: 'p', tense: false };
    case 'ㅊ':
      return { row: 'ch', tense: false };
    case 'ㅅ':
      return { row: 's', tense: false };
    case 'ㄴ':
      return { row: 'n', tense: false };
    case 'ㄹ':
      return { row: 'r', tense: false };
    case 'ㅁ':
      return { row: 'm', tense: false };
    case 'ㅎ':
      return { row: 'h', tense: false };
    default:
      return { row: '', tense: false };
  }
}

function syllableKana(row: string, medial: string): string {
  const [glide, v] = VOWEL[medial];
  if (v === 'ui') return row === '' ? 'ウィ' : ROWS[row][1];
  const plain = ROWS[row];
  if (!glide) return plain[IDX[v]];
  if (glide === 'y') {
    if (row === '') return v === 'e' ? 'イェ' : ['ヤ', '', 'ユ', '', 'ヨ'][IDX[v]] || 'ヨ';
    if (row === 's') return v === 'e' ? 'シェ' : 'シ' + Y_SMALL[v];
    if (row === 'ch' || row === 'j') return plain[IDX[v === 'e' ? 'e' : v]];
    if (v === 'e') return plain[3];
    const i = row === 't' ? 'テ' : row === 'd' ? 'デ' : plain[1];
    return i + Y_SMALL[v];
  }
  // w-glide
  if (row === '') return { a: 'ワ', i: 'ウィ', e: 'ウェ', o: 'ウォ', u: 'ウ' }[v] || 'ウ';
  if (row === 'h' && v === 'a') return 'ファ';
  if (row === 'ch' || row === 'j') return plain[IDX[v]]; // 최 → チェ, 줘 → ジョ
  const u = row === 'ch' || row === 'j' ? plain[2] : row === 't' ? 'トゥ' : row === 'd' ? 'ドゥ' : plain[2];
  return u + (W_SMALL[v] ?? '');
}

const JAMO_READ: Record<string, string> = { ㅋ: 'ク', ㅎ: 'フ' };

function wordKana(word: Syl[]): string {
  let out = '';
  let prevFinal = '';
  pronounceKorean(word).forEach((syl, k) => {
    const voiced = k > 0 && (prevFinal === '' || prevFinal === 'ㄴ' || prevFinal === 'ㄹ' || prevFinal === 'ㅁ' || prevFinal === 'ㅇ');
    const { row, tense } = consonantRow(syl.i, voiced);
    // A tense consonant gets a small ッ, unless a final consonant already closed the syllable.
    if (tense && k > 0 && !prevFinal) out += 'ッ';
    out += syllableKana(row, syl.m);
    if (syl.f) out += FINAL_KANA[syl.f] || '';
    prevFinal = syl.f;
  });
  return out;
}

/** Korean text → katakana pronunciation guide (spaces and punctuation kept). */
export function koreanToKatakana(text: string): string {
  let out = '';
  // Words joined by single spaces, read as one breath; punctuation or a line break ends the phrase.
  let phrase: string[] = [];
  let word = '';
  const endWord = () => {
    if (word) phrase.push(word);
    word = '';
  };
  const flush = () => {
    endWord();
    const sounds = phrase.map((w) => {
      const syllables = [...spokenAs(w)].map(decompose);
      stationN(syllables);
      return syllables;
    });
    for (let w = 0; w + 1 < sounds.length; w++) joinWords(sounds[w][sounds[w].length - 1], sounds[w + 1][0], phrase[w], phrase[w + 1]);
    out += sounds.map(wordKana).join(' ');
    phrase = [];
  };
  const chars = [...text];
  chars.forEach((ch, idx) => {
    if (isSyllable(ch)) {
      word += ch;
      return;
    }
    if (ch === ' ' && word.length && isSyllable(chars[idx + 1] || '')) {
      endWord();
      return;
    }
    flush();
    if (ch >= 'ㄱ' && ch <= 'ㆎ') out += JAMO_READ[ch] ?? '';
    else out += ch;
  });
  flush();
  return out.replace(/\s+/g, ' ').trim();
}

/* ---------------- Japanese kana → hangul ---------------- */

const toHiragana = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// Two-character morae first, then single ones.
const KANA_PAIRS: Record<string, string> = {
  きゃ: '캬', きゅ: '큐', きょ: '쿄', ぎゃ: '갸', ぎゅ: '규', ぎょ: '교',
  しゃ: '샤', しゅ: '슈', しょ: '쇼', しぇ: '셰', じゃ: '자', じゅ: '주', じょ: '조', じぇ: '제',
  ちゃ: '차', ちゅ: '추', ちょ: '초', ちぇ: '체', ぢゃ: '자', ぢゅ: '주', ぢょ: '조',
  にゃ: '냐', にゅ: '뉴', にょ: '뇨', ひゃ: '햐', ひゅ: '휴', ひょ: '효',
  びゃ: '뱌', びゅ: '뷰', びょ: '뵤', ぴゃ: '퍄', ぴゅ: '퓨', ぴょ: '표',
  みゃ: '먀', みゅ: '뮤', みょ: '묘', りゃ: '랴', りゅ: '류', りょ: '료',
  ふぁ: '화', ふぃ: '휘', ふぇ: '훼', ふぉ: '훠', てぃ: '티', でぃ: '디', とぅ: '투', どぅ: '두',
  うぃ: '위', うぇ: '웨', うぉ: '워', いぇ: '예', つぁ: '차', くぁ: '콰',
  ゔぁ: '바', ゔぃ: '비', ゔぇ: '베', ゔぉ: '보',
};
const KANA_ONE: Record<string, string> = {
  あ: '아', い: '이', う: '우', え: '에', お: '오',
  か: '카', き: '키', く: '쿠', け: '케', こ: '코', が: '가', ぎ: '기', ぐ: '구', げ: '게', ご: '고',
  さ: '사', し: '시', す: '스', せ: '세', そ: '소', ざ: '자', じ: '지', ず: '즈', ぜ: '제', ぞ: '조',
  た: '타', ち: '치', つ: '츠', て: '테', と: '토', だ: '다', ぢ: '지', づ: '즈', で: '데', ど: '도',
  な: '나', に: '니', ぬ: '누', ね: '네', の: '노',
  は: '하', ひ: '히', ふ: '후', へ: '헤', ほ: '호', ば: '바', び: '비', ぶ: '부', べ: '베', ぼ: '보',
  ぱ: '파', ぴ: '피', ぷ: '푸', ぺ: '페', ぽ: '포',
  ま: '마', み: '미', む: '무', め: '메', も: '모',
  や: '야', ゆ: '유', よ: '요', ら: '라', り: '리', る: '루', れ: '레', ろ: '로',
  わ: '와', ゐ: '이', ゑ: '에', を: '오', ゔ: '부',
  ぁ: '아', ぃ: '이', ぅ: '우', ぇ: '에', ぉ: '오', ゃ: '야', ゅ: '유', ょ: '요', ゎ: '와',
};

const HANGUL_BASE = 0xac00;
const addFinal = (syllable: string, finalIndex: number) => {
  const code = syllable.charCodeAt(0) - HANGUL_BASE;
  if (code < 0 || code > 11171 || code % 28 !== 0) return syllable;
  return String.fromCharCode(syllable.charCodeAt(0) + finalIndex);
};
const F_G = 1; // ㄱ
const F_N = 4; // ㄴ
const F_M = 16; // ㅁ
const F_B = 17; // ㅂ
const F_NG = 21; // ㅇ
const F_S = 19; // ㅅ

/** っ sounds like the consonant after it: がっこー → 각코오, いっぱい → 입파이, きって → 킷테. */
function geminateFinal(next: string): number {
  if ('かきくけこがぎぐげご'.includes(next)) return F_G;
  if ('ぱぴぷぺぽばびぶべぼ'.includes(next)) return F_B;
  return F_S;
}

// The vowel a long mark repeats, from the medial of the syllable before it (쿄ー → 쿄오).
const LONG_VOWEL: Record<number, string> = { 0: '아', 2: '아', 9: '아', 8: '오', 12: '오', 14: '오', 13: '우', 17: '우', 18: '우', 20: '이', 16: '이', 19: '이', 5: '에', 7: '에', 1: '에', 3: '에', 10: '에', 15: '에' };
const longVowelOf = (syllable: string) => LONG_VOWEL[Math.floor(((syllable.charCodeAt(0) - HANGUL_BASE) % 588) / 28)] || '';

// Japanese punctuation reads oddly between hangul.
const JA_PUNCT: Record<string, string> = { '、': ',', '。': '.', '！': '!', '？': '?', '　': ' ' };

// Korean words that Japanese writes in kana read best as the original (オッパ → 오빠, not 옵파).
const BORROWED: [RegExp, string][] = [
  [/옵파/g, '오빠'],
  [/온니/g, '언니'],
];

/** Which final ん becomes depends on the next sound (さんぽ → 삼포, げんき → 겡키). */
function nasalBefore(next: string): number {
  if (!next) return F_N;
  if ('まみむめもばびぶべぼぱぴぷぺぽ'.includes(next)) return F_M;
  if ('かきくけこがぎぐげご'.includes(next)) return F_NG;
  return F_N;
}

/** Japanese pronunciation kana → hangul guide. ー stays as the long-vowel mark; っ closes the previous syllable with ㅅ. */
export function kanaToHangul(kana: string): string {
  const s = toHiragana(kana);
  const out: string[] = [];
  let pendingN = false;
  let pendingTsu = false;
  const lastIsSyllable = () => out.length > 0 && /[가-힣]$/.test(out[out.length - 1]);
  const closeLast = (finalIndex: number) => {
    if (lastIsSyllable()) out[out.length - 1] = addFinal(out[out.length - 1], finalIndex);
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const pair = s.slice(i, i + 2);
    let syllable = '';
    if (KANA_PAIRS[pair]) {
      syllable = KANA_PAIRS[pair];
      i++;
    } else if (KANA_ONE[ch]) syllable = KANA_ONE[ch];
    if (ch === 'ん') {
      pendingN = true;
      continue;
    }
    if (ch === 'っ') {
      pendingTsu = true;
      continue;
    }
    if (pendingN) {
      if (lastIsSyllable()) closeLast(nasalBefore(syllable ? ch : ''));
      else out.push('ㄴ');
      pendingN = false;
    }
    if (pendingTsu) {
      if (syllable) closeLast(geminateFinal(ch));
      pendingTsu = false;
    }
    // A Korean reader stretches a vowel by writing it twice; ー between hangul reads as a dash.
    if (ch === 'ー' && lastIsSyllable()) {
      const vowel = longVowelOf(out[out.length - 1]);
      if (vowel) {
        out.push(vowel);
        continue;
      }
    }
    out.push(syllable || JA_PUNCT[ch] || ch);
  }
  if (pendingN) {
    if (lastIsSyllable()) closeLast(F_N);
    else out.push('ㄴ');
  }
  return BORROWED.reduce((text, [from, to]) => text.replace(from, to), out.join(''))
    .replace(/[ｗw]+/g, (run) => (run.length > 1 ? 'ㅋㅋ' : 'ㅋ'))
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when a string is only kana (plus long marks, spaces and punctuation) — i.e. safe to convert. */
export const isKanaOnly = (s: string) => {
  const v = s.trim();
  // Kana with any punctuation, emoji, digits or laugh marks (ｗ). Romaji, kanji or hangul mean the
  // model slipped (Codex review2 M8); an emoji must not throw the whole reading away (2026-10-10 test).
  return /[ぁ-ヺ]/.test(v) && !/[A-Za-vx-zＡ-Ｚａ-ｖｘ-ｚ一-鿿々가-힣ㄱ-ㆎ]/.test(v);
};

/* ---------------- tidying chat habits between the two languages ---------------- */

/** Korean chat marks inside Japanese text become their Japanese equivalents. */
export const tidyJapanese = (s: string) =>
  s
    .replace(/ㅋ{2,}/g, 'ｗｗ')
    .replace(/ㅋ/g, 'ｗ')
    .replace(/ㅎ{2,}/g, 'ふふ')
    .replace(/[ㅠㅜ]{2,}/g, '😭')
    .replace(/[ㅠㅜ]/g, '');

/** Japanese chat marks inside Korean text become their Korean equivalents. */
export const tidyKorean = (s: string) =>
  s
    .replace(/[ｗw]{2,}(?=\s|$|[!?！？。…])/g, 'ㅋㅋ')
    .replace(/[（(]笑[）)]/g, 'ㅋㅋ')
    .replace(/[（(]泣[）)]/g, 'ㅠㅠ');
