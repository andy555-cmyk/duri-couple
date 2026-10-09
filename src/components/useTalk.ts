import { useCallback, useEffect, useRef, useState } from 'react';
import type { Recording } from '../lib/audio';
import { blobToBase64, callGemini, failureOf, GeminiError, type Part } from '../lib/gemini';
import { fieldDone, type Partial } from '../lib/partial';
import { looksLike, systemPrompt, TALK_SCHEMA, talkPrompt, turnFromTalk, validateTalk, type TalkJson } from '../lib/prompts';
import { speak, stopSpeaking } from '../lib/speech';
import { uid } from '../lib/store';
import type { Lang, Turn } from '../lib/types';
import { other } from '../lib/types';
import { useApp } from './AppContext';
import { useVoice } from './useVoice';

interface Pending {
  audio?: Recording;
  text?: string;
  forceLang?: Lang;
}

/** What has arrived so far while the answer streams in. */
export interface LiveAnswer {
  said: string;
  translation: string;
  lang?: Lang;
  translationDone: boolean;
}

export type TalkPhase = 'idle' | 'recording' | 'working';

/** The whole talk pipeline: record or type → streamed Gemini answer → a saved Turn (+ spoken translation). */
export function useTalk() {
  const app = useApp();
  const [working, setWorking] = useState(false);
  const [workingSince, setWorkingSince] = useState(0);
  const [model, setModel] = useState('');
  const [error, setError] = useState<{ text: string; kind: string; retry: boolean } | null>(null);
  const [pendingText, setPendingText] = useState('');
  const [live, setLive] = useState<LiveAnswer | null>(null);
  const pending = useRef<Pending | null>(null);
  const forced = useRef<Lang | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  const frame = useRef(0);
  const appRef = useRef(app);
  appRef.current = app;

  const fail = useCallback((caught: unknown, canRetry: boolean) => {
    const kind = caught instanceof GeminiError ? caught.kind : (caught as Error)?.message || 'unknown';
    if (kind === 'aborted') return;
    setError({ text: appRef.current.errorText(caught), kind, retry: canRetry && !['key', 'nokey', 'silence', 'blocked'].includes(kind) });
  }, []);

  const run = useCallback(async () => {
    const input = pending.current;
    const a = appRef.current;
    // A second tap while a request is in flight must not start another one (Codex review B1).
    if (!input || abort.current) return;
    if (!a.settings.apiKey) {
      fail(new GeminiError('nokey'), false);
      return;
    }
    setError(null);
    setWorking(true);
    setWorkingSince(Date.now());
    setModel('');
    setLive(null);
    setPendingText(input.text || '');
    const controller = new AbortController();
    abort.current = controller;
    const mineOnly = () => abort.current === controller;
    const voiced = !!input.audio && a.settings.autoSpeak;
    let spoken = '';
    let latest: LiveAnswer | null = null;
    const show = () => {
      // At most one screen update per frame, however fast the words arrive.
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        setLive(latest);
      });
    };
    try {
      const parts: Part[] = [];
      if (input.audio) parts.push({ inlineData: { mimeType: input.audio.mime, data: await blobToBase64(input.audio.blob) } });
      parts.push({
        text: talkPrompt({ profile: a.profile, turns: a.turns, tone: a.settings.tone, text: input.text, forceLang: input.forceLang }),
      });
      const result = await callGemini<TalkJson>({
        key: a.settings.apiKey,
        system: systemPrompt(a.profile, a.glossary),
        parts,
        schema: TALK_SCHEMA,
        validate: validateTalk,
        timeoutMs: input.audio ? 30000 : 20000,
        // Streaming: a model that has not said a word by now gets a backup running beside it.
        hedgeMs: input.audio ? 4500 : 3500,
        signal: controller.signal,
        onModel: setModel,
        onPartial: (p: Partial<TalkJson>) => {
          const v = p.value;
          const lang: Lang | undefined = v.lang === 'ko' || v.lang === 'ja' ? v.lang : undefined;
          const translationDone = fieldDone(p, 'translation');
          latest = { said: String(v.said || ''), translation: String(v.translation || ''), lang, translationDone };
          show();
          // Speak the moment the translation is complete, while readings and suggestions still stream.
          if (voiced && !spoken && translationDone && lang && v.heard !== false && looksLike(latest.translation, other(lang))) {
            spoken = latest.translation;
            speak(spoken, other(lang), 1);
          }
        },
        onReset: () => {
          latest = null;
          show();
          if (spoken) stopSpeaking();
          spoken = '';
        },
      });
      if (result.data.heard === false || !String(result.data.said || '').trim()) throw new GeminiError('silence');
      if (result.invalid === 'said' || result.invalid === 'translation') throw failureOf(result);
      const turn: Turn = turnFromTalk(result.data, {
        input: input.audio ? 'voice' : 'text',
        model: result.model,
        ms: result.ms,
        id: uid(),
        ts: Date.now(),
      });
      if (!mineOnly() || controller.signal.aborted) return;
      appRef.current.setTurns((prev) => [...prev, turn]);
      pending.current = null;
      setPendingText('');
      if (voiced && !spoken) {
        const target = other(turn.lang);
        speak(target === 'ko' ? turn.ko : turn.ja, target, 1);
      }
    } catch (caught) {
      if (spoken) stopSpeaking();
      if (mineOnly()) fail(caught, true);
    } finally {
      if (mineOnly()) {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        setLive(null);
        setWorking(false);
        abort.current = null;
      }
    }
  }, [fail]);

  // Leaving the talk screen cancels whatever is still on its way (Codex review B2).
  useEffect(() => () => abort.current?.abort(), []);

  const voice = useVoice(
    (recording) => {
      pending.current = { audio: recording, forceLang: forced.current };
      void run();
    },
    (caught) => fail(caught, false),
    { autoEnd: app.settings.autoSend },
  );

  const startVoice = useCallback(
    (forceLang?: Lang) => {
      if (!appRef.current.settings.apiKey) {
        fail(new GeminiError('nokey'), false);
        return;
      }
      setError(null);
      forced.current = forceLang;
      void voice.start();
    },
    [fail, voice],
  );

  const sendText = useCallback(
    (text: string, forceLang?: Lang) => {
      const clean = text.trim();
      if (!clean) return;
      pending.current = { text: clean, forceLang };
      void run();
    },
    [run],
  );

  const stopWork = useCallback(() => abort.current?.abort(), []);
  const retry = useCallback(() => void run(), [run]);
  const dismiss = useCallback(() => {
    setError(null);
    pending.current = null;
    setPendingText('');
  }, []);

  const phase: TalkPhase = voice.recording ? 'recording' : working ? 'working' : 'idle';
  return {
    phase,
    voice,
    startVoice,
    sendText,
    working,
    workingSince,
    model,
    error,
    pendingText,
    live,
    retry,
    dismiss,
    stopWork,
    forcedLang: forced,
  };
}

export type Talk = ReturnType<typeof useTalk>;
