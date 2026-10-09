import { useCallback, useEffect, useRef, useState } from 'react';
import { callGemini, callsLeft, usableModels } from '../lib/gemini';
import { LiveInterpreter, type LiveCaption, type LiveFailure, type LiveState } from '../lib/live';
import { livePrompt, READINGS_SCHEMA, readingsPrompt, systemPrompt, turnFromLive, validateReadings } from '../lib/prompts';
import { stopSpeaking, unlockSpeech } from '../lib/speech';
import { uid } from '../lib/store';
import { useApp } from './AppContext';

/** Real-time interpreting for the face-to-face screen: start once, then just talk. */
export function useLive() {
  const app = useApp();
  const appRef = useRef(app);
  appRef.current = app;
  const [state, setState] = useState<LiveState>('idle');
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  const [caption, setCaption] = useState<LiveCaption>({ input: '', output: '' });
  const [last, setLast] = useState<LiveCaption | null>(null);
  const live = useRef<LiveInterpreter | null>(null);
  const levelEl = useRef<HTMLElement | null>(null);
  const frame = useRef(0);
  const pendingCaption = useRef<LiveCaption>({ input: '', output: '' });
  const toFill = useRef<string[]>([]);
  const filling = useRef(false);

  // Readings (hangul/katakana) are not part of a live answer; fill them in quietly, one at a time,
  // and only when the regular models have calls to spare this minute.
  const fillNext = useCallback(async () => {
    if (filling.current) return;
    const id = toFill.current[0];
    const a = appRef.current;
    if (!id || !a.settings.apiKey) return;
    const best = usableModels()[0];
    if (!best || (callsLeft()[best.id] ?? 0) < 2) {
      window.setTimeout(() => void fillNext(), 15000);
      return;
    }
    const turn = a.turns.find((t) => t.id === id);
    toFill.current.shift();
    if (!turn) return void fillNext();
    filling.current = true;
    try {
      const result = await callGemini<{ koKana: string; jaHangul: string }>({
        key: a.settings.apiKey,
        system: systemPrompt(a.profile, a.glossary),
        parts: [{ text: readingsPrompt(turn.ko, turn.ja) }],
        schema: READINGS_SCHEMA,
        validate: validateReadings,
        maxTokens: 1024,
        maxModels: 2,
      });
      if (!result.invalid) {
        appRef.current.setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, koKana: result.data.koKana, jaHangul: result.data.jaHangul } : t)));
      }
    } catch {
      /* readings are optional; the card offers them again later */
    } finally {
      filling.current = false;
      if (toFill.current.length) window.setTimeout(() => void fillNext(), 1500);
    }
  }, []);

  const showCaption = (next: LiveCaption) => {
    pendingCaption.current = next;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setCaption(pendingCaption.current);
    });
  };

  const stop = useCallback(() => {
    const current = live.current;
    live.current = null;
    void current?.stop();
  }, []);

  const start = useCallback(async () => {
    const a = appRef.current;
    unlockSpeech();
    stopSpeaking();
    if (live.current) return;
    if (!a.settings.apiKey) {
      a.openKey();
      return;
    }
    setFailure(null);
    setLast(null);
    const instance = new LiveInterpreter(
      { key: a.settings.apiKey, system: livePrompt(a.profile, a.glossary), speak: a.settings.autoSpeak },
      {
        onState: (next, why) => {
          if (live.current !== instance && next !== 'error') return;
          setState(next);
          if (why) setFailure(why);
        },
        onLevel: (v) => levelEl.current?.style.setProperty('--level', v.toFixed(3)),
        onCaption: showCaption,
        onTurn: ({ input, output, model }) => {
          setLast({ input, output });
          const turn = turnFromLive(input, output, { id: uid(), ts: Date.now(), model });
          if (!turn) return;
          appRef.current.setTurns((prev) => [...prev, turn]);
          toFill.current.push(turn.id);
          window.setTimeout(() => void fillNext(), 800);
        },
      },
    );
    live.current = instance;
    try {
      await instance.start();
    } catch (caught) {
      if (live.current === instance) live.current = null;
      setFailure(((caught as Error)?.message as LiveFailure) || 'unsupported');
      setState('error');
    }
  }, [fillNext]);

  // Follow the speaker toggle while running.
  useEffect(() => {
    live.current?.setSpeak(app.settings.autoSpeak);
  }, [app.settings.autoSpeak]);

  // iOS pauses the mic in the background; end the session cleanly instead of leaving it half-open.
  useEffect(() => {
    const onHide = () => document.hidden && stop();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', stop);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', stop);
      cancelAnimationFrame(frame.current);
      stop();
    };
  }, [stop]);

  const running = state === 'connecting' || state === 'listening' || state === 'translating' || state === 'reconnecting';
  return { state, running, failure, caption, last, start, stop, levelEl };
}

export type Live = ReturnType<typeof useLive>;
