import { useCallback, useEffect, useRef, useState } from 'react';
import { callGemini, callsLeft, usableModels } from '../lib/gemini';
import { LiveInterpreter, type LiveCaption, type LiveFailure, type LiveState } from '../lib/live';
import { jaReading, livePrompt, READINGS_SCHEMA, readingsPrompt, systemPrompt, turnFromLive, validateReadings } from '../lib/prompts';
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
  const fillAbort = useRef<AbortController | null>(null);
  const timers = useRef(new Set<number>());
  const alive = useRef(true);

  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      if (alive.current) fn();
    }, ms);
    timers.current.add(id);
  };

  // Readings (hangul/katakana) are not part of a live answer; fill them in quietly, one at a time,
  // and only when the regular models have calls to spare this minute.
  const fillNext = useCallback(async () => {
    if (filling.current || !alive.current) return;
    const id = toFill.current[0];
    const a = appRef.current;
    if (!id || !a.settings.apiKey) return;
    const best = usableModels()[0];
    if (!best || (callsLeft()[best.id] ?? 0) < 2) {
      later(() => void fillNext(), 15000);
      return;
    }
    const turn = a.turns.find((t) => t.id === id);
    toFill.current.shift();
    if (!turn) return void fillNext();
    filling.current = true;
    const abort = new AbortController();
    fillAbort.current = abort;
    try {
      const result = await callGemini<{ jaKana: string }>({
        signal: abort.signal,
        key: a.settings.apiKey,
        system: systemPrompt(a.profile, a.glossary),
        parts: [{ text: readingsPrompt(turn.ja) }],
        schema: READINGS_SCHEMA,
        validate: validateReadings,
        maxTokens: 1024,
        maxModels: 2,
      });
      const jaHangul = jaReading(result.data.jaKana);
      if (!result.invalid && jaHangul) {
        appRef.current.setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, jaHangul } : t)));
      }
    } catch {
      /* readings are optional; the card offers them again later */
    } finally {
      filling.current = false;
      if (fillAbort.current === abort) fillAbort.current = null;
      if (toFill.current.length) later(() => void fillNext(), 1500);
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

  // Stopping is shown at once; the old connection winds down on its own (Codex review2 H1).
  const stop = useCallback(() => {
    const current = live.current;
    live.current = null;
    setState('idle');
    setFailure(null);
    pendingCaption.current = { input: '', output: '' };
    setCaption(pendingCaption.current);
    levelEl.current?.style.setProperty('--level', '0');
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
          // Only the running instance may change the screen; an old one winding down stays silent.
          if (live.current !== instance) return;
          if (next === 'error') live.current = null;
          setState(next);
          setFailure(next === 'error' ? why || 'busy' : null);
        },
        onLevel: (v) => levelEl.current?.style.setProperty('--level', v.toFixed(3)),
        onCaption: showCaption,
        onTurn: ({ input, output, model }) => {
          setLast({ input, output });
          const turn = turnFromLive(input, output, { id: uid(), ts: Date.now(), model });
          if (!turn) return;
          appRef.current.setTurns((prev) => [...prev, turn]);
          toFill.current.push(turn.id);
          later(() => void fillNext(), 800);
        },
      },
    );
    live.current = instance;
    try {
      await instance.start();
    } catch (caught) {
      if (live.current !== instance) return;
      live.current = null;
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
    alive.current = true;
    const onHide = () => document.hidden && live.current && stop();
    const onPageHide = () => live.current && stop();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      cancelAnimationFrame(frame.current);
      for (const id of timers.current) clearTimeout(id);
      timers.current.clear();
      fillAbort.current?.abort();
      toFill.current = [];
      const current = live.current;
      live.current = null;
      void current?.stop();
    };
  }, [stop]);

  const running = state === 'connecting' || state === 'listening' || state === 'translating' || state === 'reconnecting';
  return { state, running, failure, caption, last, start, stop, levelEl };
}

export type Live = ReturnType<typeof useLive>;
