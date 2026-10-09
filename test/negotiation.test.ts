import { describe, expect, it } from 'vitest';
import { applyMove, priceLoad, startNegotiation, type NegotiationPolicy, type NegotiationState } from '../src/domain/negotiation.js';

const policy: NegotiationPolicy = { steps: [0.35, 0.7, 1.0], rounding: 5, openingRatio: 0.9, fallbackCeilingRatio: 1.0 };
const LB = 2100;
const MAX = 2450;

function run(moves: Parameters<typeof applyMove>[1][]) {
  let s: NegotiationState = startNegotiation(priceLoad(LB, MAX, policy));
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

  it('opens below the ceiling when MAX_BUY is under the listed rate (TMS data)', () => {
    // Spec transcript: RATE 2150, MAX_BUY 1950
    const p = priceLoad(2150, 1950, policy);
    expect(p).toMatchObject({ opening: 1755, ceiling: 1950, ceilingSource: 'max_buy' });
    let s = startNegotiation(p);
    const rates = [];
    for (const amount of [2300, 2250, 2200]) {
      const r = applyMove(s, { action: 'counter', amount }, policy);
      s = r.state;
      rates.push((r.decision as any).rate);
    }
    expect(rates).toEqual([1820, 1890, 1950]);
  });

  it('falls back to the listed rate as ceiling when MAX_BUY is absent', () => {
    expect(priceLoad(2150, null, policy)).toMatchObject({ ceiling: 2150, opening: 1935, ceilingSource: 'fallback' });
  });

  it('ignores moves after the negotiation is closed', () => {
    const { decisions } = run([{ action: 'decline' }, { action: 'accept' }]);
    expect(decisions[1]).toMatchObject({ decision: 'closed' });
  });
});

describe('confirmation before booking', () => {
  const fresh = () => startNegotiation(priceLoad(1277, 1552, policy));

  it('accepting our offer is already a confirmation', () => {
    const { state, decision } = applyMove(fresh(), { action: 'accept' }, policy);
    expect(decision).toMatchObject({ decision: 'accept', needsConfirmation: false });
    expect(state.confirmed).toBe(true);
  });

  it('taking the carrier ask needs their yes; a no ends it', () => {
    const a = applyMove(fresh(), { action: 'counter', amount: 1300 }, policy);
    expect(a.decision).toMatchObject({ decision: 'accept', rate: 1300, needsConfirmation: true });
    expect(a.state.confirmed).toBeFalsy();
    const yes = applyMove(a.state, { action: 'accept' }, policy);
    expect(yes.state).toMatchObject({ confirmed: true, agreedRate: 1300 });
    const no = applyMove(a.state, { action: 'decline' }, policy);
    expect(no.decision).toMatchObject({ decision: 'reject', reason: 'carrier_declined' });
  });
});
