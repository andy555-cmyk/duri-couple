import { useCallback, useRef, useState } from 'react';
import type { Recording } from '../lib/audio';
import { blobToBase64, callGemini, GeminiError, type Part } from '../lib/gemini';
import { systemPrompt, TALK_SCHEMA, talkPrompt, turnFromTalk, type TalkJson } from '../lib/prompts';
import { speak } from '../lib/speech';
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

export type TalkPhase = 'idle' | 'recording' | 'working';

/** The whole talk pipeline: record or type → Gemini → a saved Turn (+ spoken translation). */
export function useTalk() {
  const app = useApp();
  const [working, setWorking] = useState(false);
  const [workingSince, setWorkingSince] = useState(0);
  const [model, setModel] = useState('');
  const [error, setError] = useState<{ text: string; kind: string; retry: boolean } | null>(null);
  const [pendingText, setPendingText] = useState('');
  const pending = useRef<Pending | null>(null);
  const forced = useRef<Lang | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
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
    if (!input) return;
    if (!a.settings.apiKey) {
      fail(new GeminiError('nokey'), false);
      return;
    }
    setError(null);
    setWorking(true);
    setWorkingSince(Date.now());
    setModel('');
    setPendingText(input.text || '');
    const controller = new AbortController();
    abort.current = controller;
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
        timeoutMs: input.audio ? 30000 : 20000,
        signal: controller.signal,
        onModel: setModel,
      });
      if (result.data.heard === false || !String(result.data.said || '').trim()) throw new GeminiError('silence');
      const turn: Turn = turnFromTalk(result.data, {
        input: input.audio ? 'voice' : 'text',
        model: result.model,
        ms: result.ms,
        id: uid(),
        ts: Date.now(),
      });
      appRef.current.setTurns((prev) => [...prev, turn]);
      pending.current = null;
      setPendingText('');
      if (input.audio && appRef.current.settings.autoSpeak) {
        const target = other(turn.lang);
        speak(target === 'ko' ? turn.ko : turn.ja, target, 1);
      }
    } catch (caught) {
      fail(caught, true);
    } finally {
      setWorking(false);
      abort.current = null;
    }
  }, [fail]);

  const voice = useVoice(
    (recording) => {
      pending.current = { audio: recording, forceLang: forced.current };
      void run();
    },
    (caught) => fail(caught, false),
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
    retry,
    dismiss,
    stopWork,
    forcedLang: forced,
  };
}

export type Talk = ReturnType<typeof useTalk>;
