import 'server-only';
import type { CallRow, OpsStatus } from './types';
import { sampleCalls, sampleOps } from './sample';

// Twin access, server side only (the key is a secret; the browser only gets rendered HTML).
// Preferred: HappyRobot public API v2 with an organization key (docs: API Reference → Twin).
// Fallback: the Twin gateway, for when this runs inside HappyRobot Apps.
const apiKey = process.env.HAPPYROBOT_API_KEY;
const apiBase = (process.env.HAPPYROBOT_API_BASE || 'https://platform.happyrobot.ai/api/v2').replace(/\/$/, '');
// Inside HappyRobot Apps these come as NEXT_PUBLIC_*; outside (Railway) use the plain names.
const gateway = (process.env.TWIN_GATEWAY_URL || process.env.NEXT_PUBLIC_TWIN_GATEWAY)?.replace(/\/$/, '');
const orgId = process.env.TWIN_ORG_ID || process.env.NEXT_PUBLIC_ORG_ID;
const table = process.env.TWIN_TABLE || 'carrier_calls';

const mode: 'api' | 'gateway' | 'sample' = apiKey ? 'api' : gateway && orgId ? 'gateway' : 'sample';
export const usingSampleData = mode === 'sample';

const PAGE = 500; // API v2 max per request
const MAX_ROWS = 5000;

async function request(url: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (mode === 'api') headers.authorization = `Bearer ${apiKey}`;
  else headers['x-org-id'] = orgId!;
  const res = await fetch(url, { ...init, headers, cache: 'no-store' });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Twin returned ${res.status}${res.status === 429 ? ' (rate limit, retry in a minute)' : ''}${detail ? `: ${detail}` : ''}`);
  }
  return res.json() as Promise<unknown>;
}

async function fetchRawRows(): Promise<unknown[]> {
  if (mode === 'gateway') {
    const body = (await request(`${gateway}/${table}?limit=${PAGE}`)) as unknown;
    return Array.isArray(body) ? body : ((body as { data?: unknown[]; rows?: unknown[] }).data ?? (body as { rows?: unknown[] }).rows ?? []);
  }
  // GET /twin/tables/{table}?limit&offset → { rows, total }. No ordering, so page through and sort here.
  const out: unknown[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const body = (await request(`${apiBase}/twin/tables/${encodeURIComponent(table)}?limit=${PAGE}&offset=${offset}`)) as { rows?: unknown[]; total?: number };
    const rows = body.rows ?? [];
    out.push(...rows);
    if (rows.length < PAGE || (body.total !== undefined && out.length >= body.total)) break;
  }
  return out;
}

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

export async function fetchCalls(): Promise<CallRow[]> {
  if (usingSampleData) return sampleCalls();
  return (await fetchRawRows())
    .map((r) => toCallRow(r as Record<string, unknown>))
    .filter((r): r is CallRow => r !== null)
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
}

/** Records the ops manager's action on a call. Needs an `ops_status` text column in the table. */
export async function setOpsStatus(runId: string, status: OpsStatus): Promise<void> {
  if (usingSampleData) {
    sampleOps.set(runId, status);
    return;
  }
  if (mode === 'api') {
    // PATCH /twin/tables/{table}/rows { primaryKey, updates } (docs: "Update a row in a Twin table").
    try {
      await request(`${apiBase}/twin/tables/${encodeURIComponent(table)}/rows`, {
        method: 'PATCH',
        body: JSON.stringify({ primaryKey: { run_id: runId }, updates: { ops_status: status } }),
      });
    } catch (err) {
      // 409 = the table has no primary key, so Twin refuses row edits. Fall back to SQL (POST /twin/sql).
      if (!String(err).includes('Twin returned 409')) throw err;
      await request(`${apiBase}/twin/sql`, { method: 'POST', body: JSON.stringify({ sql: opsStatusSql(runId, status) }) });
    }
    return;
  }
  // Gateway: update syntax not documented; assumed from its REST mirror of the schema.
  await request(`${gateway}/${table}?run_id=eq.${encodeURIComponent(runId)}`, { method: 'PATCH', body: JSON.stringify({ ops_status: status }) });
}

/** Built only from validated values: run ids are platform ids and status is one of two literals. */
export function opsStatusSql(runId: string, status: OpsStatus): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId)) throw new Error('unexpected run id format');
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new Error('unexpected table name');
  const value = status === null ? 'NULL' : `'${status === 'confirmed' ? 'confirmed' : 'followed_up'}'`;
  return `UPDATE ${table} SET ops_status = ${value} WHERE run_id = '${runId}'`;
}
