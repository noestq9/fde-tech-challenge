// Deterministic pricing and negotiation. The LLM never sees the ceiling and never decides a price:
// it relays the carrier's number here and reads back the decision.

export const MAX_CARRIER_COUNTERS = 3;

export interface NegotiationPolicy {
  /** Share of the (ceiling - opening) gap conceded on counter rounds 1..3. */
  steps: number[];
  /** Offers are rounded down to this many dollars. */
  rounding: number;
  /** Opening offer is at most this share of the ceiling (keeps room to negotiate when the ceiling is below the listed rate). */
  openingRatio: number;
  /** Ceiling as a share of the listed rate when the TMS does not expose MAX_BUY for this token. */
  fallbackCeilingRatio: number;
}

export interface Pricing {
  listedRate: number;
  ceiling: number;
  opening: number;
  ceilingSource: 'max_buy' | 'fallback';
}

/**
 * Opening offer = min(listed rate, ceiling × openingRatio).
 * - Ceiling above the listed rate (classic brokerage case): we open at the listed rate and can move up.
 * - Ceiling below the listed rate (what the TMS returns, e.g. RATE 2150 / MAX_BUY 1950): we open below the
 *   ceiling, because offering the listed rate would already break it.
 */
export function priceLoad(listedRate: number, maxBuy: number | null, policy: NegotiationPolicy): Pricing {
  const ceilingSource = maxBuy != null && maxBuy > 0 ? 'max_buy' : 'fallback';
  const ceiling = ceilingSource === 'max_buy' ? maxBuy! : Math.floor(listedRate * policy.fallbackCeilingRatio);
  const capped = ceiling * policy.openingRatio;
  // Offer the listed rate exactly when there is room above it; only a computed opening gets rounded.
  const opening = listedRate <= capped ? listedRate : roundDown(capped, policy.rounding);
  return { listedRate, ceiling, opening: Math.min(opening, ceiling), ceilingSource };
}

export interface NegotiationState {
  listedRate: number;
  ceiling: number;
  opening: number;
  /** Last price we put on the table (starts at the opening offer). */
  currentOffer: number;
  /** Number of carrier counter-offers processed so far. */
  carrierCounters: number;
  status: 'open' | 'agreed' | 'failed';
  agreedRate?: number;
  /** True once the carrier has said yes to agreedRate out loud. Booking requires it. */
  confirmed?: boolean;
  history: Array<{ round: number; carrierAsk?: number; ourOffer?: number; event: string }>;
}

export type CarrierMove = { action: 'counter'; amount: number } | { action: 'accept' } | { action: 'decline' };

export type Decision =
  | { decision: 'accept'; rate: number; round: number; needsConfirmation: boolean }
  | { decision: 'confirm'; rate: number }
  | { decision: 'counter'; rate: number; round: number; roundsLeft: number; final: boolean }
  | { decision: 'reject'; round: number; reason: 'max_rounds' | 'carrier_declined' }
  | { decision: 'closed'; reason: string };

export function startNegotiation(p: Pricing): NegotiationState {
  return {
    listedRate: p.listedRate,
    ceiling: p.ceiling,
    opening: p.opening,
    currentOffer: p.opening,
    carrierCounters: 0,
    status: 'open',
    history: [{ round: 0, ourOffer: p.opening, event: 'initial_offer' }],
  };
}

export function offerForRound(state: NegotiationState, round: number, policy: NegotiationPolicy): number {
  const share = policy.steps[Math.min(round, policy.steps.length) - 1] ?? 0;
  const raw = state.opening + (state.ceiling - state.opening) * share;
  return clamp(roundDown(raw, policy.rounding), state.opening, state.ceiling);
}

/** Applies one carrier move and returns the new state plus the decision. Pure function. */
export function applyMove(
  state: NegotiationState,
  move: CarrierMove,
  policy: NegotiationPolicy,
): { state: NegotiationState; decision: Decision } {
  // We took the carrier's own number: the carrier still has to hear it and say yes before we book.
  if (state.status === 'agreed' && !state.confirmed) {
    const s: NegotiationState = { ...state, history: [...state.history] };
    const rate = s.agreedRate!;
    if (move.action === 'accept') {
      s.confirmed = true;
      s.history.push({ round: s.carrierCounters, ourOffer: rate, event: 'carrier_confirmed' });
      return { state: s, decision: { decision: 'accept', rate, round: s.carrierCounters, needsConfirmation: false } };
    }
    if (move.action === 'decline') {
      s.status = 'failed';
      s.history.push({ round: s.carrierCounters, event: 'carrier_declined' });
      return { state: s, decision: { decision: 'reject', round: s.carrierCounters, reason: 'carrier_declined' } };
    }
    return { state, decision: { decision: 'confirm', rate } };
  }
  if (state.status !== 'open') return { state, decision: { decision: 'closed', reason: `negotiation already ${state.status}` } };
  const s: NegotiationState = { ...state, history: [...state.history] };

  if (move.action === 'accept') {
    s.status = 'agreed';
    s.agreedRate = s.currentOffer;
    s.confirmed = true;
    s.history.push({ round: s.carrierCounters, ourOffer: s.currentOffer, event: 'carrier_accepted' });
    return { state: s, decision: { decision: 'accept', rate: s.currentOffer, round: s.carrierCounters, needsConfirmation: false } };
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
    return { state: s, decision: { decision: 'accept', rate, round, needsConfirmation: true } };
  }

  s.currentOffer = ourNext;
  s.history.push({ round, carrierAsk: ask, ourOffer: ourNext, event: 'counter' });
  const roundsLeft = MAX_CARRIER_COUNTERS - round;
  return { state: s, decision: { decision: 'counter', rate: ourNext, round, roundsLeft, final: roundsLeft === 0 } };
}

function roundDown(n: number, step: number) {
  return Math.floor(n / step) * step;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(Math.max(n, lo), hi);
}
