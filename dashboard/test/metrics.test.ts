import { describe, expect, it } from 'vitest';
import { inRange, kpis, needsAttention, outcomeBreakdown } from '../lib/metrics';
import { sampleCalls } from '../lib/sample';
import type { CallRow } from '../lib/types';

const row = (o: Partial<CallRow>): CallRow => ({
  run_id: 'r', mc_number: null, carrier_name: null, outcome: null, failure_reason: null, load_id: null, lane_origin: null,
  lane_destination: null, equipment_type: null, loadboard_rate: null, agreed_rate: null, agreed_vs_loadboard_pct: null,
  negotiation_rounds: null, otp_verified: null, booking_status: null, sentiment: null, run_url: null, completed_at: null, ops_status: null, ...o,
});

describe('kpis', () => {
  it('measures the booking rate against verified carriers only', () => {
    const k = kpis([
      row({ outcome: 'booked', otp_verified: true, agreed_vs_loadboard_pct: 10, negotiation_rounds: 2 }),
      row({ outcome: 'failed_negotiation', otp_verified: true }),
      row({ outcome: 'fmcsa_failed', otp_verified: false }),
      row({ outcome: 'otp_failed', otp_verified: false }),
    ]);
    expect(k).toMatchObject({ calls: 4, booked: 1, verified: 2, bookingRate: 0.5, avgPremiumPct: 10, avgRounds: 2, otpLockouts: 1 });
  });

  it('returns null rates with no data instead of NaN', () => {
    expect(kpis([])).toMatchObject({ bookingRate: null, avgPremiumPct: null, avgRounds: null });
  });
});

describe('needsAttention', () => {
  it('puts unconfirmed TMS bookings first and drops handled calls', () => {
    const items = needsAttention([
      row({ run_id: 'a', outcome: 'booked', booking_status: 'BOOKED' }),
      row({ run_id: 'b', outcome: 'booked', booking_status: 'UNKNOWN' }),
      row({ run_id: 'c', outcome: 'booked', booking_status: 'BOOKED', ops_status: 'confirmed' }),
      row({ run_id: 'd', outcome: 'no_loads' }),
    ]);
    expect(items.map((i) => [i.row.run_id, i.reason])).toEqual([['b', 'booking_unconfirmed'], ['a', 'confirm_booking']]);
  });
});

describe('inRange and breakdown', () => {
  it('filters by date and counts outcomes', () => {
    const now = Date.parse('2026-10-08T00:00:00Z');
    const rows = [row({ outcome: 'booked', completed_at: '2026-10-07T00:00:00Z' }), row({ outcome: 'booked', completed_at: '2026-09-01T00:00:00Z' })];
    expect(inRange(rows, '7d', now)).toHaveLength(1);
    expect(outcomeBreakdown(rows)).toEqual([{ outcome: 'booked', label: 'Booked', count: 2 }]);
  });

  it('sample data covers every outcome the backend produces', () => {
    const outcomes = new Set(sampleCalls().map((r) => r.outcome));
    for (const o of ['booked', 'failed_negotiation', 'carrier_declined', 'no_loads', 'fmcsa_failed', 'otp_failed', 'integration_error', 'abandoned']) {
      expect(outcomes.has(o)).toBe(true);
    }
  });
});
