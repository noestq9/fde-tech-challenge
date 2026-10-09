// Read-only: lists every load the TMS returns, state by state, with its status (OPEN / BOOKED / ...).
// Bookings are per token, so loads we booked during testing show as BOOKED and the agent skips them.
//   npm run tms:inventory

import { LtmsClient } from '../integrations/tms/ltmsClient.js';
import type { LoadSummary } from '../integrations/tms/types.js';
import { loadDotEnv, need } from './env.js';

loadDotEnv();
const client = new LtmsClient({
  host: need('TMS_HOST'), port: Number(need('TMS_PORT')), token: need('TMS_TOKEN'),
  connectTimeoutMs: 2000, requestTimeoutMs: 3000, retries: 3, budgetMs: 15000, maxResults: 500,
});

const STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const seen = new Map<string, LoadSummary>();
const failed: string[] = [];
for (const st of STATES) {
  try {
    for (const l of await client.searchLoads({ originState: st, maxResults: 500 })) seen.set(l.loadId, l);
  } catch {
    failed.push(st);
  }
}

const rows = [...seen.values()].sort((a, b) => a.status.localeCompare(b.status) || a.origin.localeCompare(b.origin));
console.log('| Load | Status | Origin | Destination | Equipment | Pickup | Rate |');
console.log('|---|---|---|---|---|---|---|');
for (const l of rows) console.log(`| ${l.loadId} | ${l.status} | ${l.origin} | ${l.destination} | ${l.equipmentType} | ${l.pickupDatetime} | ${l.loadboardRate} |`);
const open = rows.filter((l) => l.status === 'OPEN').length;
console.log(`\n${rows.length} loads, ${open} OPEN.${failed.length ? ` States that failed after retries: ${failed.join(' ')}` : ''}`);
