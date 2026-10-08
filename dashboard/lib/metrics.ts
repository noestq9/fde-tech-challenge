import type { CallRow } from './types';

export const OUTCOME_LABELS: Record<string, string> = {
  booked: 'Booked',
  failed_negotiation: 'No deal after 3 rounds',
  carrier_declined: 'Carrier declined',
  no_loads: 'No matching loads',
  fmcsa_failed: 'Failed FMCSA check',
  otp_failed: 'Failed verification code',
  integration_error: 'System error',
  abandoned: 'Hung up early',
};

export type Range = '7d' | '30d' | 'all';

export function inRange(rows: CallRow[], range: Range, now = Date.now()): CallRow[] {
  if (range === 'all') return rows;
  const cutoff = now - (range === '7d' ? 7 : 30) * 86_400_000;
  return rows.filter((r) => !r.completed_at || Date.parse(r.completed_at) >= cutoff);
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function kpis(rows: CallRow[]) {
  const booked = rows.filter((r) => r.outcome === 'booked');
  const verified = rows.filter((r) => r.otp_verified);
  return {
    calls: rows.length,
    booked: booked.length,
    verified: verified.length,
    // Northstar: of the carriers we could legally talk price with, how many we booked.
    bookingRate: verified.length ? booked.length / verified.length : null,
    // Paid above the listed rate on booked loads (lower is better for the broker).
    avgPremiumPct: avg(booked.map((r) => r.agreed_vs_loadboard_pct).filter((v): v is number => v !== null)),
    avgRounds: avg(booked.map((r) => r.negotiation_rounds).filter((v): v is number => v !== null)),
    otpLockouts: rows.filter((r) => r.outcome === 'otp_failed').length,
    systemErrors: rows.filter((r) => r.outcome === 'integration_error').length,
  };
}

export function outcomeBreakdown(rows: CallRow[]) {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.outcome ?? 'abandoned', (counts.get(r.outcome ?? 'abandoned') ?? 0) + 1);
  return [...counts.entries()]
    .map(([outcome, count]) => ({ outcome, label: OUTCOME_LABELS[outcome] ?? outcome, count }))
    .sort((a, b) => b.count - a.count);
}

export type AttentionReason = 'confirm_booking' | 'booking_unconfirmed' | 'otp_lockout' | 'system_error';

/** Calls the ops manager has to act on, most urgent first. Cleared once ops_status is set. */
export function needsAttention(rows: CallRow[]) {
  const items: Array<{ row: CallRow; reason: AttentionReason; text: string }> = [];
  for (const r of rows) {
    if (r.ops_status) continue;
    if (r.outcome === 'booked' && r.booking_status && r.booking_status !== 'BOOKED') {
      items.push({ row: r, reason: 'booking_unconfirmed', text: 'TMS did not confirm the booking. Check the load in the TMS before calling the carrier.' });
    } else if (r.outcome === 'booked') {
      items.push({ row: r, reason: 'confirm_booking', text: 'Booked by the agent. Senior rep to confirm and collect paperwork.' });
    } else if (r.outcome === 'integration_error') {
      items.push({ row: r, reason: 'system_error', text: 'Call ended on a system error. Call the carrier back.' });
    } else if (r.outcome === 'otp_failed') {
      items.push({ row: r, reason: 'otp_lockout', text: 'Three wrong verification codes. Review for a possible impersonation attempt.' });
    }
  }
  const order: AttentionReason[] = ['booking_unconfirmed', 'system_error', 'confirm_booking', 'otp_lockout'];
  return items.sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason));
}
