// Deterministic negotiation policy. The LLM never sees max_rate and never decides a price:
// it relays the carrier's number here and reads back the decision.

export const MAX_CARRIER_COUNTERS = 3;

export interface NegotiationPolicy {
  /** Share of the (ceiling - listed) gap conceded on counter rounds 1..3. */
  steps: number[];
  /** Offers are rounded down to this many dollars. */
  rounding: number;
}

export interface NegotiationState {
  loadboardRate: number;
  maxRate: number;
  /** Last price we put on the table (starts at loadboard_rate). */
  currentOffer: number;
  /** Number of carrier counter-offers processed so far. */
  carrierCounters: number;
  status: 'open' | 'agreed' | 'failed';
  agreedRate?: number;
  history: Array<{ round: number; carrierAsk?: number; ourOffer?: number; event: string }>;
}

export type CarrierMove = { action: 'counter'; amount: number } | { action: 'accept' } | { action: 'decline' };

export type Decision =
  | { decision: 'accept'; rate: number; round: number }
  | { decision: 'counter'; rate: number; round: number; roundsLeft: number; final: boolean }
  | { decision: 'reject'; round: number; reason: 'max_rounds' | 'carrier_declined' }
  | { decision: 'closed'; reason: string };

export function startNegotiation(loadboardRate: number, maxRate: number): NegotiationState {
  // A ceiling below the listed rate is a data error; never pay above the listed rate in that case.
  const ceiling = Math.max(maxRate, 0) < loadboardRate ? loadboardRate : maxRate;
  return {
    loadboardRate,
    maxRate: ceiling,
    currentOffer: loadboardRate,
    carrierCounters: 0,
    status: 'open',
    history: [{ round: 0, ourOffer: loadboardRate, event: 'initial_offer' }],
  };
}

export function offerForRound(state: NegotiationState, round: number, policy: NegotiationPolicy): number {
  const share = policy.steps[Math.min(round, policy.steps.length) - 1] ?? 0;
  const raw = state.loadboardRate + (state.maxRate - state.loadboardRate) * share;
  const rounded = Math.floor(raw / policy.rounding) * policy.rounding;
  return clamp(rounded, state.loadboardRate, state.maxRate);
}

/** Applies one carrier move and returns the new state plus what the agent should say. Pure function. */
export function applyMove(
  state: NegotiationState,
  move: CarrierMove,
  policy: NegotiationPolicy,
): { state: NegotiationState; decision: Decision } {
  if (state.status !== 'open') return { state, decision: { decision: 'closed', reason: `negotiation already ${state.status}` } };
  const s: NegotiationState = { ...state, history: [...state.history] };

  if (move.action === 'accept') {
    s.status = 'agreed';
    s.agreedRate = s.currentOffer;
    s.history.push({ round: s.carrierCounters, ourOffer: s.currentOffer, event: 'carrier_accepted' });
    return { state: s, decision: { decision: 'accept', rate: s.currentOffer, round: s.carrierCounters } };
  }

  if (move.action === 'decline') {
    s.status = 'failed';
    s.history.push({ round: s.carrierCounters, event: 'carrier_declined' });
    return { state: s, decision: { decision: 'reject', round: s.carrierCounters, reason: 'carrier_declined' } };
  }

  const ask = Math.round(move.amount);
  if (s.carrierCounters >= MAX_CARRIER_COUNTERS) {
    s.status = 'failed';
    s.history.push({ round: s.carrierCounters, carrierAsk: ask, event: 'max_rounds' });
    return { state: s, decision: { decision: 'reject', round: s.carrierCounters, reason: 'max_rounds' } };
  }

  s.carrierCounters += 1;
  const round = s.carrierCounters;
  const ourNext = offerForRound(s, round, policy);

  // Carrier asks for no more than what we were about to offer: take their (cheaper) number.
  if (ask <= Math.max(ourNext, s.currentOffer)) {
    const rate = Math.max(ask, 0);
    s.status = 'agreed';
    s.agreedRate = rate;
    s.history.push({ round, carrierAsk: ask, event: 'accepted_carrier_ask' });
    return { state: s, decision: { decision: 'accept', rate, round } };
  }

  s.currentOffer = ourNext;
  s.history.push({ round, carrierAsk: ask, ourOffer: ourNext, event: 'counter' });
  const roundsLeft = MAX_CARRIER_COUNTERS - round;
  return { state: s, decision: { decision: 'counter', rate: ourNext, round, roundsLeft, final: roundsLeft === 0 } };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(Math.max(n, lo), hi);
}
