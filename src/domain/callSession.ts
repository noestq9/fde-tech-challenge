import type { CarrierProfile } from '../integrations/fmcsa.js';
import type { NegotiationState } from './negotiation.js';

// Per-call working state. It is short-lived (minutes) and lives in memory with a TTL.
// The durable record is the call summary, which the workflow writes to Twin at the end of the call.

export type Outcome =
  | 'booked'
  | 'failed_negotiation'
  | 'carrier_declined'
  | 'fmcsa_failed'
  | 'otp_failed'
  | 'no_loads'
  | 'integration_error'
  | 'abandoned';

export interface CallSession {
  callId: string;
  startedAt: string;
  updatedAt: string;
  mcNumber?: string;
  carrier?: CarrierProfile;
  fmcsaStatus?: string;
  fmcsaReasons?: string[];
  otp?: { channel: 'sms' | 'email'; masked: string; source: 'directory' | 'fmcsa' | 'caller_provided' };
  otpVerified: boolean;
  search?: { origin?: string; destination?: string; equipmentType?: string; resultCount: number };
  loadsOffered: string[];
  negotiations: Record<string, NegotiationState>;
  booking?: { loadId: string; rate: number; confirmation: string; handoffId: string };
  outcome?: Outcome;
  failureReason?: string;
  integrationErrors: Array<{ system: 'fmcsa' | 'tms' | 'otp'; error: string; at: string }>;
  events: Array<{ at: string; event: string; detail?: Record<string, unknown> }>;
}

export class CallSessionStore {
  private sessions = new Map<string, { s: CallSession; expiresAt: number }>();

  constructor(private readonly ttlSeconds: number, private readonly now: () => number = Date.now) {}

  get(callId: string): CallSession {
    this.sweep();
    const hit = this.sessions.get(callId);
    if (hit) {
      hit.expiresAt = this.now() + this.ttlSeconds * 1000;
      return hit.s;
    }
    const ts = new Date(this.now()).toISOString();
    const s: CallSession = { callId, startedAt: ts, updatedAt: ts, otpVerified: false, loadsOffered: [], negotiations: {}, integrationErrors: [], events: [] };
    this.sessions.set(callId, { s, expiresAt: this.now() + this.ttlSeconds * 1000 });
    return s;
  }

  event(s: CallSession, event: string, detail?: Record<string, unknown>) {
    s.updatedAt = new Date(this.now()).toISOString();
    s.events.push({ at: s.updatedAt, event, detail });
  }

  private sweep() {
    const t = this.now();
    for (const [k, v] of this.sessions) if (v.expiresAt < t) this.sessions.delete(k);
  }
}

/** Flat record for Twin and the ops dashboard. Contains no max_rate. */
export function summarize(s: CallSession) {
  const loadId = s.booking?.loadId ?? Object.keys(s.negotiations).at(-1);
  const n = loadId ? s.negotiations[loadId] : undefined;
  const carrierAsks = n?.history.filter((h) => h.carrierAsk != null).map((h) => h.carrierAsk!) ?? [];
  const ourOffers = n?.history.filter((h) => h.ourOffer != null).map((h) => h.ourOffer!) ?? [];
  const ended = new Date(s.updatedAt).getTime();
  return {
    call_id: s.callId,
    started_at: s.startedAt,
    ended_at: s.updatedAt,
    duration_s: Math.round((ended - new Date(s.startedAt).getTime()) / 1000),
    mc_number: s.mcNumber ?? null,
    carrier_name: s.carrier?.legalName ?? null,
    fmcsa_status: s.fmcsaStatus ?? null,
    otp_channel: s.otp?.channel ?? null,
    otp_source: s.otp?.source ?? null,
    otp_verified: s.otpVerified,
    lane_origin: s.search?.origin ?? null,
    lane_destination: s.search?.destination ?? null,
    equipment_type: s.search?.equipmentType ?? null,
    loads_found: s.search?.resultCount ?? null,
    load_id: loadId ?? null,
    loadboard_rate: n?.loadboardRate ?? null,
    carrier_offers: carrierAsks,
    our_offers: ourOffers,
    negotiation_rounds: n?.carrierCounters ?? 0,
    agreed_rate: s.booking?.rate ?? n?.agreedRate ?? null,
    // Margin signal without exposing the ceiling: how much of the listed rate we had to add.
    uplift_vs_loadboard_pct: n && (s.booking?.rate ?? n.agreedRate) ? round2((((s.booking?.rate ?? n.agreedRate)! - n.loadboardRate) / n.loadboardRate) * 100) : null,
    outcome: s.outcome ?? 'abandoned',
    failure_reason: s.failureReason ?? null,
    integration_errors: s.integrationErrors.length,
    tms_confirmation: s.booking?.confirmation ?? null,
    handoff_id: s.booking?.handoffId ?? null,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
