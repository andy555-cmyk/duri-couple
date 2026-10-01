import type { Lang } from './types';

let voices: SpeechSynthesisVoice[] = [];
let unlocked = false;

const supported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

export function initSpeech() {
  if (!supported()) return;
  const load = () => {
    voices = window.speechSynthesis.getVoices();
  };
  load();
  window.speechSynthesis.addEventListener?.('voiceschanged', load);
}

const PREFERRED = ['premium', 'enhanced', 'siri', 'kyoko', 'o-ren', 'yuna', 'google'];

function pickVoice(lang: Lang) {
  const code = lang === 'ko' ? 'ko' : 'ja';
  const list = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(code));
  const rank = (v: SpeechSynthesisVoice) => {
    const name = v.name.toLowerCase();
    const index = PREFERRED.findIndex((p) => name.includes(p));
    return index < 0 ? PREFERRED.length : index;
  };
  return list.sort((a, b) => rank(a) - rank(b))[0];
}

/** iOS only lets pages speak after speech was started inside a tap; call this from a tap. */
export function unlockSpeech() {
  if (!supported() || unlocked) return;
  unlocked = true;
  try {
    const silent = new SpeechSynthesisUtterance(' ');
    silent.volume = 0;
    window.speechSynthesis.speak(silent);
  } catch {
    /* ignore */
  }
}

export function speak(text: string, lang: Lang, rate = 1, onEnd?: () => void) {
  if (!supported() || !text.trim()) return;
  const synth = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang === 'ko' ? 'ko-KR' : 'ja-JP';
  const voice = pickVoice(lang);
  if (voice) utterance.voice = voice;
  utterance.rate = rate;
  if (onEnd) {
    utterance.onend = onEnd;
    utterance.onerror = onEnd;
  }
  const wasBusy = synth.speaking || synth.pending;
  synth.cancel();
  // Safari drops an utterance queued in the same tick as cancel().
  if (wasBusy) setTimeout(() => synth.speak(utterance), 60);
  else synth.speak(utterance);
}

export function stopSpeaking() {
  if (supported()) window.speechSynthesis.cancel();
}
