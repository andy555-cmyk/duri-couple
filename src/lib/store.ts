import { useCallback, useEffect, useRef, useState } from 'react';
import type { GlossaryItem, Lang, Phrase, Profile, Settings, Turn } from './types';
import { other } from './types';

export const KEYS = {
  profile: 'duri.profile',
  settings: 'duri.settings',
  turns: 'duri.turns',
  phrases: 'duri.phrases',
  glossary: 'duri.glossary',
  daily: 'duri.daily',
} as const;

export const DEFAULT_PROFILE: Profile = {
  myLang: 'ko',
  myName: '',
  partnerName: '',
  startDate: '',
  meCalls: '',
  partnerCalls: '',
  style: 'casual',
};

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  tone: 'natural',
  autoSpeak: true,
  slowRate: 0.6,
  onboarded: false,
};

export function uid() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

let storageListener: ((ok: boolean) => void) | undefined;
export const onStorageProblem = (fn: (ok: boolean) => void) => {
  storageListener = fn;
};

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) return { ...fallback, ...parsed };
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    storageListener?.(true);
  } catch {
    storageListener?.(false);
  }
}

/** useState that mirrors itself into localStorage. */
export function usePersistent<T>(key: string, fallback: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => load(key, fallback));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    save(key, value);
  }, [key, value]);
  const update = useCallback((next: T | ((prev: T) => T)) => setValue(next as any), []);
  return [value, update];
}

/** Like useState, but survives iOS Safari silently reloading a background tab (e.g. after switching to LINE). */
export function useSession<T>(key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* private mode */
      }
    },
    [key],
  );
  return [value, update];
}

/* ---------- spaced repetition (Leitner boxes) ---------- */

const DAY = 86400000;
const INTERVALS = [0, 1, 2, 4, 8, 16, 32].map((d) => d * DAY);

export function grade(phrase: Phrase, knew: boolean, now = Date.now()): Phrase {
  const box = knew ? Math.min(phrase.box + 1, INTERVALS.length - 1) : 0;
  return {
    ...phrase,
    box,
    due: knew ? now + INTERVALS[box] : now + 10 * 60000,
    seen: phrase.seen + 1,
    right: phrase.right + (knew ? 1 : 0),
  };
}

export const duePhrases = (phrases: Phrase[], now = Date.now()) =>
  phrases.filter((p) => p.due <= now).sort((a, b) => a.due - b.due);

export function phraseFrom(src: { ko: string; ja: string; koKana: string; jaHangul: string; note?: string }): Phrase {
  return {
    id: uid(),
    ts: Date.now(),
    ko: src.ko,
    ja: src.ja,
    koKana: src.koKana,
    jaHangul: src.jaHangul,
    note: src.note,
    box: 0,
    due: Date.now(),
    seen: 0,
    right: 0,
  };
}

/* ---------- share link: couple info + dictionary for the partner's phone ---------- */

export interface SharePayload {
  v: 1;
  fromLang: Lang;
  fromName: string;
  toName: string;
  startDate: string;
  fromCalls: string;
  toCalls: string;
  style: Profile['style'];
  glossary: { ko: string; ja: string; note?: string }[];
}

function toBase64Url(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(data: string) {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((data.length + 3) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function makeShareLink(profile: Profile, glossary: GlossaryItem[], base: string): string {
  const payload: SharePayload = {
    v: 1,
    fromLang: profile.myLang,
    fromName: profile.myName,
    toName: profile.partnerName,
    startDate: profile.startDate,
    fromCalls: profile.meCalls,
    toCalls: profile.partnerCalls,
    style: profile.style,
    glossary: glossary.map(({ ko, ja, note }) => ({ ko, ja, ...(note ? { note } : {}) })),
  };
  return `${base}#join=${toBase64Url(JSON.stringify(payload))}`;
}

export function readShareHash(hash: string): SharePayload | null {
  const match = hash.match(/join=([A-Za-z0-9_-]+)/);
  if (!match) return null;
  try {
    const payload = JSON.parse(fromBase64Url(match[1]));
    if (payload?.v !== 1 || (payload.fromLang !== 'ko' && payload.fromLang !== 'ja')) return null;
    if (!Array.isArray(payload.glossary)) payload.glossary = [];
    return payload as SharePayload;
  } catch {
    return null;
  }
}

/** The receiver sees everything from the other side: names and nicknames swap. */
export function profileFromShare(payload: SharePayload, current: Profile): Profile {
  return {
    ...current,
    myLang: other(payload.fromLang),
    myName: current.myName || payload.toName || '',
    partnerName: current.partnerName || payload.fromName || '',
    startDate: current.startDate || payload.startDate || '',
    meCalls: current.meCalls || payload.toCalls || '',
    partnerCalls: current.partnerCalls || payload.fromCalls || '',
    style: payload.style || current.style,
  };
}

export function mergeGlossary(current: GlossaryItem[], incoming: { ko: string; ja: string; note?: string }[]): GlossaryItem[] {
  const seen = new Set(current.map((g) => `${g.ko.trim()}|${g.ja.trim()}`));
  const added = incoming
    .filter((g) => g && typeof g.ko === 'string' && typeof g.ja === 'string')
    .filter((g) => !seen.has(`${g.ko.trim()}|${g.ja.trim()}`))
    .map((g) => ({ id: uid(), ko: g.ko, ja: g.ja, note: g.note }));
  return [...current, ...added];
}

/* ---------- backup ---------- */

export interface Backup {
  app: 'duri-couple';
  v: 2;
  exportedAt: string;
  profile: Profile;
  turns: Turn[];
  phrases: Phrase[];
  glossary: GlossaryItem[];
}

export function makeBackup(data: Omit<Backup, 'app' | 'v' | 'exportedAt'>): Backup {
  return { app: 'duri-couple', v: 2, exportedAt: new Date().toISOString(), ...data };
}

export function parseBackup(text: string): Backup {
  const data = JSON.parse(text);
  if (data?.app !== 'duri-couple') throw new Error('not a backup');
  return {
    app: 'duri-couple',
    v: 2,
    exportedAt: String(data.exportedAt || ''),
    profile: { ...DEFAULT_PROFILE, ...(data.profile || {}) },
    turns: Array.isArray(data.turns) ? data.turns : [],
    phrases: Array.isArray(data.phrases) ? data.phrases : [],
    glossary: Array.isArray(data.glossary) ? data.glossary : [],
  };
}

export function mergeById<T extends { id: string; ts?: number }>(current: T[], incoming: T[]): T[] {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) if (item && item.id && !map.has(item.id)) map.set(item.id, item);
  return [...map.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

export function dateKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
