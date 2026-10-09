import { useCallback, useEffect, useRef, useState } from 'react';
import { Recorder, type Recording } from '../lib/audio';
import { stopSpeaking, unlockSpeech } from '../lib/speech';

/**
 * Tap to start; it stops by itself when the speaker goes quiet (autoEnd), or on a second tap.
 * The level is written straight into a CSS variable so frequent updates never re-render React.
 */
export function useVoice(onDone: (recording: Recording) => void, onError: (error: Error) => void, opts: { autoEnd?: boolean } = {}) {
  const autoEnd = useRef(opts.autoEnd);
  autoEnd.current = opts.autoEnd;
  const [recording, setRecording] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const recorder = useRef<Recorder | null>(null);
  const levelEl = useRef<HTMLElement | null>(null);
  const done = useRef(onDone);
  const fail = useRef(onError);
  done.current = onDone;
  fail.current = onError;

  const setLevel = useCallback((value: number) => {
    levelEl.current?.style.setProperty('--level', value.toFixed(3));
  }, []);

  const stop = useCallback(async () => {
    const active = recorder.current;
    if (!active) return;
    recorder.current = null;
    const result = await active.stop();
    setRecording(false);
    if (!result) return;
    if (active.stoppedForSilence) {
      fail.current(new Error('silence'));
      return;
    }
    if (result.blob.size < 1200 || result.ms < 500) {
      fail.current(new Error('short'));
      return;
    }
    done.current(result);
  }, []);

  const start = useCallback(async () => {
    unlockSpeech();
    stopSpeaking();
    if (recorder.current) return;
    const next = new Recorder({
      onLevel: setLevel,
      onAutoStop: () => void stop(),
      onBroken: () => {
        if (recorder.current !== next) return;
        recorder.current = null;
        setRecording(false);
        setLevel(0);
      },
      autoEnd: !!autoEnd.current,
    });
    recorder.current = next;
    try {
      const started = await next.start();
      // Cancelled or stopped while the permission prompt was up.
      if (!started || recorder.current !== next) {
        next.cancel();
        return;
      }
      setStartedAt(Date.now());
      setRecording(true);
    } catch (error) {
      recorder.current = null;
      fail.current(error as Error);
    }
  }, [setLevel, stop]);

  const cancel = useCallback(() => {
    recorder.current?.cancel();
    recorder.current = null;
    setRecording(false);
  }, []);

  const toggle = useCallback(() => (recorder.current ? stop() : start()), [start, stop]);

  useEffect(() => {
    // Leaving the screen or the app always releases the microphone; iOS may only send
    // visibilitychange when switching apps (Codex review2 M6).
    const release = () => {
      if (!recorder.current) return;
      recorder.current.cancel();
      recorder.current = null;
      setRecording(false);
    };
    const onHide = () => document.hidden && release();
    window.addEventListener('pagehide', release);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', release);
      document.removeEventListener('visibilitychange', onHide);
      recorder.current?.cancel();
    };
  }, []);

  return { recording, startedAt, start, stop, cancel, toggle, levelEl };
}

/** Seconds since `from`, ticking twice a second while `active`. */
export function useElapsed(active: boolean, from: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active, from]);
  return active ? Math.max(0, Math.floor((now - from) / 1000)) : 0;
}
