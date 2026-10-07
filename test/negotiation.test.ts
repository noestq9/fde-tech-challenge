import { describe, expect, it } from 'vitest';
import { applyMove, startNegotiation, type NegotiationPolicy, type NegotiationState } from '../src/domain/negotiation.js';

const policy: NegotiationPolicy = { steps: [0.35, 0.7, 1.0], rounding: 5 };
const LB = 2100;
const MAX = 2450;

function run(moves: Parameters<typeof applyMove>[1][]) {
  let s: NegotiationState = startNegotiation(LB, MAX);
  const decisions = [];
  for (const m of moves) {
    const r = applyMove(s, m, policy);
    s = r.state;
    decisions.push(r.decision);
  }
  return { s, decisions };
}

describe('negotiation policy', () => {
  it('accepts the listed rate when the carrier takes the first offer', () => {
    const { s, decisions } = run([{ action: 'accept' }]);
    expect(decisions[0]).toMatchObject({ decision: 'accept', rate: LB });
    expect(s.agreedRate).toBe(LB);
  });

  it('accepts a carrier ask that is at or below our next step', () => {
    // round 1 step = 2100 + 350*0.35 = 2222.5 -> 2220
    const { decisions } = run([{ action: 'counter', amount: 2200 }]);
    expect(decisions[0]).toMatchObject({ decision: 'accept', rate: 2200 });
  });

  it('counters with stepped concessions and never above the ceiling', () => {
    const { decisions } = run([
      { action: 'counter', amount: 3000 },
      { action: 'counter', amount: 2900 },
      { action: 'counter', amount: 2800 },
    ]);
    expect(decisions.map((d) => (d as any).rate)).toEqual([2220, 2345, 2450]);
    expect(decisions[2]).toMatchObject({ decision: 'counter', final: true, roundsLeft: 0 });
    for (const d of decisions) expect((d as any).rate).toBeLessThanOrEqual(MAX);
  });

  it('fails after three carrier counters with no deal', () => {
    const { s, decisions } = run([
      { action: 'counter', amount: 3000 },
      { action: 'counter', amount: 2900 },
      { action: 'counter', amount: 2800 },
      { action: 'counter', amount: 2700 },
    ]);
    expect(decisions[3]).toMatchObject({ decision: 'reject', reason: 'max_rounds' });
    expect(s.status).toBe('failed');
  });

  it('lets the carrier accept our final offer', () => {
    const { s } = run([
      { action: 'counter', amount: 3000 },
      { action: 'counter', amount: 2900 },
      { action: 'counter', amount: 2800 },
      { action: 'accept' },
    ]);
    expect(s.agreedRate).toBe(2450);
  });

  it('never agrees above the ceiling, whatever the sequence', () => {
    for (let i = 0; i < 2000; i++) {
      const moves = Array.from({ length: 5 }, () =>
        Math.random() < 0.2 ? ({ action: 'accept' } as const) : ({ action: 'counter', amount: 1500 + Math.random() * 2000 } as const),
      );
      const { s } = run(moves);
      if (s.agreedRate != null) expect(s.agreedRate).toBeLessThanOrEqual(MAX);
    }
  });

  it('treats a ceiling below the listed rate as the listed rate', () => {
    const s = startNegotiation(2000, 1800);
    const r = applyMove(s, { action: 'counter', amount: 2500 }, policy);
    expect(r.decision).toMatchObject({ decision: 'counter', rate: 2000 });
  });

  it('ignores moves after the negotiation is closed', () => {
    const { decisions } = run([{ action: 'decline' }, { action: 'accept' }]);
    expect(decisions[1]).toMatchObject({ decision: 'closed' });
  });
});
