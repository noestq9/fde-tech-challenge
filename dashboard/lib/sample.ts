import type { CallRow, OpsStatus } from './types';

// Preview data for when the Twin gateway is not configured. Mirrors what the backend's
// finalize record looks like for each outcome, over the last two weeks.
export const sampleOps = new Map<string, OpsStatus>();

const lanes: Array<[string, string, string, number]> = [
  ['Houston, TX', 'Memphis, TN', 'DRY_VAN', 1277],
  ['Atlanta, GA', 'Dallas, TX', 'DRY_VAN', 2150],
  ['Chicago, IL', 'Columbus, OH', 'REEFER', 1480],
  ['Miami, FL', 'Newark, NJ', 'REEFER', 3420],
  ['Gary, IN', 'Denver, CO', 'FLATBED', 3300],
  ['Austin, TX', 'Phoenix, AZ', 'DRY_VAN', 2640],
];
const carriers = ['Blue Ridge Transport LLC', 'Lakeshore Reefer Inc', 'Red Mesa Freight', 'Great Plains Haulers', 'Coastal Line Carriers', 'Iron Horse Logistics'];
const plan: Array<[CallRow['outcome'], string | null]> = [
  ['booked', 'BOOKED'], ['booked', 'BOOKED'], ['failed_negotiation', null], ['booked', 'BOOKED'], ['no_loads', null],
  ['otp_failed', null], ['booked', 'BOOKED_UNCONFIRMED'], ['carrier_declined', null], ['booked', 'BOOKED'], ['fmcsa_failed', null],
  ['abandoned', null], ['booked', 'BOOKED'], ['failed_negotiation', null], ['booked', 'BOOKED'], ['integration_error', null],
  ['booked', 'BOOKED'], ['carrier_declined', null], ['booked', 'UNKNOWN'], ['booked', 'BOOKED'], ['failed_negotiation', null],
  ['booked', 'BOOKED'], ['no_loads', null], ['booked', 'BOOKED'], ['otp_failed', null],
];
const failure: Record<string, string> = {
  failed_negotiation: 'max_rounds', otp_failed: 'max_attempts', fmcsa_failed: 'not_authorized', no_loads: 'no_match', integration_error: 'tms_timeout',
};

export function sampleCalls(now = Date.now()): CallRow[] {
  return plan.map(([outcome, bookingStatus], i) => {
    const [origin, destination, equipment, rate] = lanes[i % lanes.length]!;
    const booked = outcome === 'booked';
    const rounds = booked || outcome === 'failed_negotiation' ? [1, 2, 0, 3, 1, 2][i % 6]! : 0;
    const pct = booked ? [4.2, 7.9, 0, 11.3, 3.1, 6.4][i % 6]! : null;
    const verified = !['fmcsa_failed', 'otp_failed'].includes(outcome!) && outcome !== 'abandoned';
    const runId = `sample-${String(i + 1).padStart(3, '0')}`;
    return {
      run_id: runId,
      mc_number: String(123456 + i * 1111),
      carrier_name: carriers[i % carriers.length]!,
      outcome,
      failure_reason: failure[outcome!] ?? null,
      load_id: booked || outcome === 'failed_negotiation' || outcome === 'carrier_declined' ? `LD00${900 + i}` : null,
      lane_origin: origin,
      lane_destination: destination,
      equipment_type: equipment,
      loadboard_rate: verified && outcome !== 'no_loads' ? rate : null,
      agreed_rate: pct === null ? null : Math.round((rate * (1 + pct / 100)) / 5) * 5,
      agreed_vs_loadboard_pct: pct,
      negotiation_rounds: rounds,
      otp_verified: verified,
      booking_status: bookingStatus,
      sentiment: booked ? 'positive' : outcome === 'failed_negotiation' ? 'negative' : 'neutral',
      run_url: null,
      completed_at: new Date(now - i * 13.7 * 3600_000).toISOString(),
      ops_status: sampleOps.has(runId) ? sampleOps.get(runId)! : i % 5 === 3 && booked ? 'confirmed' : null,
    };
  });
}
