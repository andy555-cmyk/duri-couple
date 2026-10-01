import { useCallback, useEffect, useRef, useState } from 'react';
import { Recorder, type Recording } from '../lib/audio';
import { stopSpeaking, unlockSpeech } from '../lib/speech';

/**
 * Tap-to-start / tap-to-stop recording with a live level meter.
 * The level is written straight into a CSS variable so 60 fps updates never re-render React.
 */
export function useVoice(onDone: (recording: Recording) => void, onError: (error: Error) => void) {
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
    const next = new Recorder(setLevel, () => void stop());
    recorder.current = next;
    try {
      await next.start();
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

  useEffect(() => () => recorder.current?.cancel(), []);

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
