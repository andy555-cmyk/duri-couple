import { describe, expect, it } from 'vitest';
import { SpeechGate } from '../src/lib/audio';

const run = (gate: SpeechGate, level: number, ms: number, step = 40) => {
  const events: string[] = [];
  for (let t = 0; t < ms; t += step) {
    const e = gate.feed(level, step);
    if (e !== 'none') events.push(e);
  }
  return events;
};

describe('knowing when someone has finished talking', () => {
  it('ends after speech followed by a quiet spell', () => {
    const gate = new SpeechGate(1200);
    expect(run(gate, 0.03, 400)).toEqual([]);
    expect(run(gate, 0.5, 1500)).toEqual(['speech']);
    expect(run(gate, 0.03, 800)).toEqual([]);
    expect(run(gate, 0.03, 600)).toEqual(['end']);
    expect(run(gate, 0.03, 2000)).toEqual([]);
  });
  it('does not end on a short pause in the middle of a sentence', () => {
    const gate = new SpeechGate(1200);
    run(gate, 0.6, 1000);
    expect(run(gate, 0.02, 700)).toEqual([]);
    expect(run(gate, 0.6, 600)).toEqual([]);
    expect(run(gate, 0.02, 1300)).toEqual(['end']);
  });
  it('ignores a cough-length blip', () => {
    const gate = new SpeechGate(1200, 9000);
    expect(run(gate, 0.7, 120)).toEqual([]);
    expect(gate.heard).toBe(false);
    expect(run(gate, 0.02, 3000)).toEqual([]);
  });
  it('gives up when nobody speaks', () => {
    const gate = new SpeechGate(1200, 3000);
    expect(run(gate, 0.03, 3100)).toEqual(['nothing']);
  });
  it('adapts to a noisy room', () => {
    const gate = new SpeechGate(1200);
    run(gate, 0.09, 3000);
    expect(gate.threshold).toBeGreaterThan(0.2);
    expect(run(gate, 0.1, 1000)).toEqual([]);
    expect(run(gate, 0.7, 600)).toEqual(['speech']);
  });
});
