// Smoke test for a running deployment (local Docker or cloud). Does not need the OTP code.
//   API_URL=https://your-app.example.com npm run smoke
import { loadDotEnv, need } from './env.js';

loadDotEnv();
const base = (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 8080}`).replace(/\/$/, '');
const key = need('API_KEY');
const callId = `smoke-${Date.now()}`;
let failed = 0;

async function check(name: string, fn: () => Promise<boolean | string>) {
  try {
    const r = await fn();
    const pass = r === true || typeof r === 'string';
    if (!pass) failed++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${typeof r === 'string' ? `: ${r}` : ''}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}: ${(err as Error).message}`);
  }
}

const post = (path: string, body: unknown, k = key) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': k }, body: JSON.stringify(body) });

await check('GET /health', async () => {
  const r = await fetch(`${base}/health`);
  return r.ok ? JSON.stringify(await r.json()) : false;
});
await check('rejects a wrong API key (401)', async () => (await post(`/v1/calls/${callId}/verify-carrier`, { mc_number: '123456' }, 'nope')).status === 401);
await check('rejects a missing API key (401)', async () => (await fetch(`${base}/v1/calls/${callId}`)).status === 401);
await check('verify-carrier answers', async () => {
  const j = await (await post(`/v1/calls/${callId}/verify-carrier`, { mc_number: process.env.SMOKE_MC ?? '123456' })).json();
  return j.ok !== undefined ? JSON.stringify(j) : false;
});
await check('blocks load search before OTP', async () => {
  const j = await (await post(`/v1/calls/${callId}/loads/search`, { origin: 'Chicago' })).json();
  return j.error === 'identity_not_verified';
});
await check('rejects invalid input (400)', async () => (await post(`/v1/calls/${callId}/negotiate`, { action: 'counter' })).status === 400);

console.log(failed ? `\n${failed} check(s) failed against ${base}` : `\nAll checks passed against ${base}`);
process.exit(failed ? 1 : 0);
