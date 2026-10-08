// One row of the Twin table written after every call (the backend's `finalize` record).
// Every field is optional: the table is mapped by hand in the workflow, so the app must tolerate gaps.
export type Outcome =
  | 'booked'
  | 'failed_negotiation'
  | 'carrier_declined'
  | 'fmcsa_failed'
  | 'otp_failed'
  | 'no_loads'
  | 'integration_error'
  | 'abandoned';

export type OpsStatus = 'confirmed' | 'followed_up' | null;

export interface CallRow {
  run_id: string;
  mc_number: string | null;
  carrier_name: string | null;
  outcome: Outcome | string | null;
  failure_reason: string | null;
  load_id: string | null;
  lane_origin: string | null;
  lane_destination: string | null;
  equipment_type: string | null;
  loadboard_rate: number | null;
  agreed_rate: number | null;
  agreed_vs_loadboard_pct: number | null;
  negotiation_rounds: number | null;
  otp_verified: boolean | null;
  booking_status: string | null;
  sentiment: string | null;
  run_url: string | null;
  completed_at: string | null;
  ops_status: OpsStatus;
}
