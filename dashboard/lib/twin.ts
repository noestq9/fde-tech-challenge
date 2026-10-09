import 'server-only';
import type { CallRow, OpsStatus } from './types';
import { sampleCalls, sampleOps } from './sample';

// Twin gateway access. Server only: anyone who reads the browser bundle could otherwise
// query the gateway as the organization (docs: "Using Twin in Apps").
// Inside HappyRobot Apps these come as NEXT_PUBLIC_*; outside (Railway) use the plain names.
const gateway = (process.env.TWIN_GATEWAY_URL || process.env.NEXT_PUBLIC_TWIN_GATEWAY)?.replace(/\/$/, '');
const orgId = process.env.TWIN_ORG_ID || process.env.NEXT_PUBLIC_ORG_ID;
const table = process.env.TWIN_TABLE || 'carrier_calls';

export const usingSampleData = !gateway || !orgId;

const num = (v: unknown) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
const bool = (v: unknown) => (v === null || v === undefined ? null : v === true || v === 'true' || v === 1);

/** Coerces a raw Twin row into a CallRow. Accepts call_id as a stand-in for run_id. */
export function toCallRow(r: Record<string, unknown>): CallRow | null {
  const runId = str(r.run_id ?? r.call_id);
  if (!runId) return null;
  const ops = str(r.ops_status);
  return {
    run_id: runId,
    mc_number: str(r.mc_number),
    carrier_name: str(r.carrier_name),
    outcome: str(r.outcome),
    failure_reason: str(r.failure_reason),
    load_id: str(r.load_id),
    lane_origin: str(r.lane_origin),
    lane_destination: str(r.lane_destination),
    equipment_type: str(r.equipment_type),
    loadboard_rate: num(r.loadboard_rate),
    agreed_rate: num(r.agreed_rate),
    agreed_vs_loadboard_pct: num(r.agreed_vs_loadboard_pct),
    negotiation_rounds: num(r.negotiation_rounds),
    otp_verified: bool(r.otp_verified),
    booking_status: str(r.booking_status),
    sentiment: str(r.sentiment),
    run_url: str(r.run_url),
    completed_at: str(r.completed_at ?? r.ended_at ?? r.__completed_at__),
    ops_status: ops === 'confirmed' || ops === 'followed_up' ? ops : null,
  };
}

export async function fetchCalls(limit = 500): Promise<CallRow[]> {
  if (usingSampleData) return sampleCalls();
  const res = await fetch(`${gateway}/${table}?limit=${limit}`, { headers: { 'x-org-id': orgId! }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Twin gateway returned ${res.status}`);
  const body = (await res.json()) as unknown;
  const rows = Array.isArray(body) ? body : ((body as { data?: unknown[]; rows?: unknown[] }).data ?? (body as { rows?: unknown[] }).rows ?? []);
  return rows
    .map((r) => toCallRow(r as Record<string, unknown>))
    .filter((r): r is CallRow => r !== null)
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
}

/**
 * Records the ops manager's action on a call. Needs an `ops_status` text column in the table.
 * The update syntax (PATCH with ?run_id=eq.<id>) is assumed from the gateway's REST mirror of the
 * schema; it is not confirmed in the HappyRobot docs, so a failure is surfaced to the user verbatim.
 */
export async function setOpsStatus(runId: string, status: OpsStatus): Promise<void> {
  if (usingSampleData) {
    sampleOps.set(runId, status);
    return;
  }
  const res = await fetch(`${gateway}/${table}?run_id=eq.${encodeURIComponent(runId)}`, {
    method: 'PATCH',
    headers: { 'x-org-id': orgId!, 'content-type': 'application/json' },
    body: JSON.stringify({ ops_status: status }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Twin gateway returned ${res.status} on update`);
}
