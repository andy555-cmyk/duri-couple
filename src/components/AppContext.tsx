import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorKey, makeT, type T } from '../lib/i18n';
import { DEFAULT_PROFILE, DEFAULT_SETTINGS, KEYS, onStorageProblem, phraseFrom, usePersistent } from '../lib/store';
import type { Daily, GlossaryItem, Lang, Phrase, Profile, Settings, Turn } from '../lib/types';
import { other } from '../lib/types';
import { GeminiError } from '../lib/gemini';

export interface AppState {
  t: T;
  my: Lang;
  their: Lang;
  profile: Profile;
  setProfile: (next: Profile | ((p: Profile) => Profile)) => void;
  settings: Settings;
  setSettings: (next: Settings | ((s: Settings) => Settings)) => void;
  turns: Turn[];
  setTurns: (next: Turn[] | ((t: Turn[]) => Turn[])) => void;
  phrases: Phrase[];
  setPhrases: (next: Phrase[] | ((p: Phrase[]) => Phrase[])) => void;
  glossary: GlossaryItem[];
  setGlossary: (next: GlossaryItem[] | ((g: GlossaryItem[]) => GlossaryItem[])) => void;
  daily: Daily | null;
  setDaily: (next: Daily | null) => void;
  toast: (text: string) => void;
  keepPhrase: (src: { ko: string; ja: string; koKana: string; jaHangul: string; note?: string }) => void;
  isKept: (src: { ko: string; ja: string }) => boolean;
  errorText: (error: unknown) => string;
  openKey: () => void;
  keyRequest: number;
  partnerName: string;
  myName: string;
}

const Ctx = createContext<AppState | null>(null);

export function useApp() {
  const value = useContext(Ctx);
  if (!value) throw new Error('AppContext missing');
  return value;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = usePersistent<Profile>(KEYS.profile, DEFAULT_PROFILE);
  const [settings, setSettings] = usePersistent<Settings>(KEYS.settings, DEFAULT_SETTINGS);
  const [turns, setTurns] = usePersistent<Turn[]>(KEYS.turns, []);
  const [phrases, setPhrases] = usePersistent<Phrase[]>(KEYS.phrases, []);
  const [glossary, setGlossary] = usePersistent<GlossaryItem[]>(KEYS.glossary, []);
  const [daily, setDaily] = usePersistent<Daily | null>(KEYS.daily, null);
  const [toastText, setToastText] = useState('');
  const [keyRequest, setKeyRequest] = useState(0);
  const toastTimer = useRef(0);
  const [storageOk, setStorageOk] = useState(true);

  const t = useMemo(() => makeT(profile.myLang), [profile.myLang]);
  const my = profile.myLang;
  const their = other(my);

  useEffect(() => onStorageProblem(setStorageOk), []);
  useEffect(() => {
    document.documentElement.lang = my;
    document.title = t('appName');
  }, [my, t]);

  const toast = useCallback((text: string) => {
    setToastText(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastText(''), 2400);
  }, []);

  const isKept = useCallback(
    (src: { ko: string; ja: string }) => phrases.some((p) => p.ko.trim() === src.ko.trim() && p.ja.trim() === src.ja.trim()),
    [phrases],
  );

  const keepPhrase = useCallback(
    (src: { ko: string; ja: string; koKana: string; jaHangul: string; note?: string }) => {
      setPhrases((prev) => {
        const existing = prev.find((p) => p.ko.trim() === src.ko.trim() && p.ja.trim() === src.ja.trim());
        if (existing) return prev.filter((p) => p !== existing);
        return [phraseFrom(src), ...prev];
      });
    },
    [setPhrases],
  );

  const errorText = useCallback(
    (error: unknown) => {
      const kind = error instanceof GeminiError ? error.kind : (error as Error)?.message || '';
      const key = errorKey(kind);
      if (key) return t(key);
      if (error instanceof GeminiError) return t('err.request', { detail: `${error.status || ''} ${error.detail}`.trim().slice(0, 80) });
      return t('err.format');
    },
    [t],
  );

  const value: AppState = {
    t,
    my,
    their,
    profile,
    setProfile,
    settings,
    setSettings,
    turns,
    setTurns,
    phrases,
    setPhrases,
    glossary,
    setGlossary,
    daily,
    setDaily,
    toast,
    keepPhrase,
    isKept,
    errorText,
    openKey: () => setKeyRequest((n) => n + 1),
    keyRequest,
    partnerName: profile.partnerName.trim() || t('partner'),
    myName: profile.myName.trim() || t('me'),
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {!storageOk && <div className="storage-warning">{t('err.storage')}</div>}
      <div className={`toast ${toastText ? 'show' : ''}`} role="status" aria-live="polite">
        {toastText}
      </div>
    </Ctx.Provider>
  );
}
