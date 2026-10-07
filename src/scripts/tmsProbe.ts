// Probe the real legacy TMS (or the fake one) and answer the spec's open questions empirically.
// Read-only by default. `--book <LOAD_ID> <RATE>` performs ONE real booking (bookings can't be undone for your token).
//
//   npm run tms:probe              -> uses TMS_HOST / TMS_PORT / TMS_TOKEN from .env
//   npm run tms:probe -- --samples 50

import { encodeRequest, parseResponse, redact } from '../integrations/tms/protocol.js';
import { LtmsClient } from '../integrations/tms/ltmsClient.js';
import { sendRequest } from '../integrations/tms/transport.js';
import { loadDotEnv, need } from './env.js';

loadDotEnv();
const host = need('TMS_HOST');
const port = Number(need('TMS_PORT'));
const token = need('TMS_TOKEN');
const args = process.argv.slice(2);
const samples = Number(args[args.indexOf('--samples') + 1]) || 30;
const timeoutMs = Number(process.env.TMS_TIMEOUT_MS ?? 3000);

const client = new LtmsClient({ host, port, token, connectTimeoutMs: 2000, requestTimeoutMs: timeoutMs, retries: 3, budgetMs: 15000, maxResults: 10 });
const ok = (b: boolean) => (b ? 'PASS' : 'FAIL');
const results: Array<[string, string, string]> = [];
const record = (check: string, status: string, detail: string) => {
  results.push([check, status, detail]);
  console.log(`${status.padEnd(5)} ${check}: ${detail}`);
};

async function raw(fields: Record<string, string | number>, cmd: 'LOAD_QUERY' | 'LOAD_GET' = 'LOAD_QUERY') {
  const t0 = Date.now();
  try {
    const lines = await sendRequest(encodeRequest(cmd, token, fields), { host, port, connectTimeoutMs: 2000, requestTimeoutMs: timeoutMs });
    const out = parseResponse(lines);
    return { category: out.kind === 'ok' ? 'ok' : `err:${out.code}`, ms: Date.now() - t0, out };
  } catch (err) {
    return { category: (err as Error).name, ms: Date.now() - t0, out: null };
  }
}

async function main() {
  console.log(`Probing LTMS at ${host}:${port} (token redacted: ${redact(`AUTH:${token}`)})\n`);

  // 1. Transport, framing, auth (no fault injection on DEBUG_ECHO)
  try {
    const echo = await client.ping('probe', { X: '1', Y: '2', Z: '3' });
    record('DEBUG_ECHO conformance', ok(echo.fieldsParsed === 6 && echo.msg === 'probe'), `FIELDS_PARSED=${echo.fieldsParsed} (expected 6)`);
  } catch (err) {
    record('DEBUG_ECHO conformance', 'FAIL', String(err));
    console.log('\nTransport/auth failed; stopping. Check host, port and token.');
    process.exit(1);
  }

  // 2. Search through the resilient client
  const found = await client.searchLoads({ originState: 'GA', equipmentType: 'DRY_VAN' }).catch((e) => e as Error);
  if (found instanceof Error) record('LOAD_QUERY via client', 'FAIL', found.message);
  else record('LOAD_QUERY via client', 'PASS', `${found.length} loads, e.g. ${found[0]?.loadId ?? '-'}`);

  // 3. Detail + MAX_BUY flag on this token
  const anyId = found instanceof Error ? undefined : found[0]?.loadId;
  if (anyId) {
    const d = await client.getLoad(anyId).catch((e) => e as Error);
    if (d instanceof Error || !d) record('LOAD_GET via client', 'FAIL', d instanceof Error ? d.message : 'null');
    else {
      record('LOAD_GET via client', 'PASS', `${d.loadId} ${d.origin} -> ${d.destination} rate=${d.loadboardRate} status=${d.status}`);
      record('Token exposes MAX_BUY', d.maxRate != null ? 'INFO' : 'WARN', d.maxRate != null ? `yes (MAX_BUY ${d.maxRate} vs RATE ${d.loadboardRate})` : 'no: ceiling will fall back to FALLBACK_CEILING_RATIO x RATE');
    }
  }

  // 4. Equipment types the generator returns
  const eq: string[] = [];
  for (const t of ['DRY_VAN', 'REEFER', 'FLATBED', 'STEP_DECK', 'POWER_ONLY', 'CONESTOGA']) {
    const r = await client.searchLoads({ equipmentType: t, maxResults: 3 }).catch(() => null);
    if (r?.length) eq.push(t);
  }
  record('EQTYPE values with results', 'INFO', eq.join(', ') || 'none');

  // 5. Pickup date filter name/format (unknown fields are silently ignored, so compare result sets)
  const base = await raw({ ORIG_STATE: 'GA', MAX_RESULTS: 50 });
  const baseCount = base.out?.kind === 'ok' ? base.out.records.length : -1;
  const sampleDate = base.out?.kind === 'ok' ? base.out.records[0]?.PICKUP_DT?.slice(0, 8) : undefined;
  if (sampleDate) {
    for (const v of [sampleDate, `${sampleDate}000000`]) {
      const r = await raw({ ORIG_STATE: 'GA', PICKUP_DT: v, MAX_RESULTS: 50 });
      const n = r.out?.kind === 'ok' ? r.out.records.length : -1;
      record(`PICKUP_DT:${v} filters?`, 'INFO', `${n} results vs ${baseCount} unfiltered (${r.category})`);
    }
  }

  // 6. MAX_RESULTS ceiling
  const big = await raw({ ORIG_STATE: 'TX', MAX_RESULTS: 500 });
  record('MAX_RESULTS ceiling', 'INFO', big.out?.kind === 'ok' ? `asked 500, got ${big.out.records.length}` : big.category);

  // 7. Fault profile: N raw LOAD_QUERY requests without retries
  const tally: Record<string, number> = {};
  const lat: number[] = [];
  for (let i = 0; i < samples; i++) {
    const r = await raw({ ORIG_STATE: 'GA', MAX_RESULTS: 5 });
    tally[r.category] = (tally[r.category] ?? 0) + 1;
    lat.push(r.ms);
  }
  lat.sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  record('Fault profile (raw, no retries)', 'INFO', `${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ')} | p50=${pct(0.5)}ms p95=${pct(0.95)}ms`);

  // 8. Same load through the resilient client: should succeed despite faults
  let okCount = 0;
  for (let i = 0; i < 10; i++) if (await client.searchLoads({ originState: 'GA', maxResults: 5 }).then(() => true, () => false)) okCount++;
  record('Resilient client success rate', okCount >= 9 ? 'PASS' : 'WARN', `${okCount}/10 searches succeeded with retries`);

  // 9. Optional single real booking
  const bi = args.indexOf('--book');
  if (bi !== -1) {
    const loadId = args[bi + 1]!;
    const rate = Number(args[bi + 2]);
    const b = await client.bookLoad(loadId, process.env.PROBE_MC ?? '872144', rate).catch((e) => e as Error);
    record(`LOAD_BOOK ${loadId} @ ${rate}`, b instanceof Error ? 'INFO' : 'PASS', b instanceof Error ? `${(b as any).kind ?? ''} ${b.message}` : `${b.status} ${b.bookingRef ?? ''}`);
    const after = await client.getLoad(loadId).catch(() => null);
    record('STATUS after booking', 'INFO', after?.status ?? 'unknown');
  }

  console.log('\n| Check | Result | Detail |\n|---|---|---|');
  for (const [c, s, d] of results) console.log(`| ${c} | ${s} | ${d.replace(/\|/g, '/')} |`);
  process.exit(results.some(([, s]) => s === 'FAIL') ? 1 : 0);
}

main();
