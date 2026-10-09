export type Lang = 'ko' | 'ja';
export type Tone = 'sweet' | 'natural' | 'playful' | 'serious';
export type Channel = 'talk' | 'msg-in' | 'msg-out';

/** A better-sounding alternative to the plain translation, chosen by the speaker. */
export interface Alt {
  text: string;
  reading: string;
  meaning: string;
  why: string;
}

export interface Word {
  w: string;
  r: string;
  m: string;
}

/** A ready-to-send line in the partner's language. */
export interface Line {
  label?: string;
  text: string;
  reading: string;
  meaning: string;
  why?: string;
}

/** One utterance or message, always stored with both languages and both readings. */
export interface Turn {
  id: string;
  ts: number;
  lang: Lang;
  channel: Channel;
  input: 'voice' | 'text';
  ko: string;
  ja: string;
  koKana: string;
  jaHangul: string;
  alt?: Alt;
  useAlt?: boolean;
  note?: string;
  nuance?: string;
  words?: Word[];
  lines?: Line[];
  star?: boolean;
  memo?: string;
  model?: string;
  ms?: number;
}

export interface Phrase {
  id: string;
  ts: number;
  ko: string;
  ja: string;
  koKana: string;
  jaHangul: string;
  note?: string;
  box: number;
  due: number;
  seen: number;
  right: number;
}

export interface GlossaryItem {
  id: string;
  ko: string;
  ja: string;
  note?: string;
}

/** How someone talks: Japanese differs a lot by gender (俺/僕 vs 私), so translations follow it. '' = not set. */
export type Gender = '' | 'm' | 'f';

export interface Profile {
  myLang: Lang;
  myName: string;
  partnerName: string;
  startDate: string;
  meCalls: string;
  partnerCalls: string;
  style: 'casual' | 'polite';
  meGender: Gender;
  partnerGender: Gender;
}

export interface Settings {
  apiKey: string;
  tone: Tone;
  autoSpeak: boolean;
  /** Stop recording and translate as soon as the speaker goes quiet. */
  autoSend: boolean;
  slowRate: number;
  onboarded: boolean;
}

export interface Daily {
  date: string;
  ko: string;
  ja: string;
  koKana: string;
  jaHangul: string;
  note: string;
}

export const other = (lang: Lang): Lang => (lang === 'ko' ? 'ja' : 'ko');
