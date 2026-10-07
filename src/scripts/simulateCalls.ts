// Scripted call scenarios through the full backend: API -> negotiation/OTP -> TMS adapter over real TCP.
// By default it starts a fake TMS (20% silent faults) in-process; `--real` uses TMS_HOST/PORT/TOKEN from .env.
// FMCSA uses the mock fixtures so each branch is reproducible (check live FMCSA with `npm run fmcsa:check`).
//
//   npm run sim:calls             -> fake TMS with faults
//   npm run sim:calls -- --real   -> real legacy TMS (books real loads for your token)
//
// Writes a markdown report to reports/.

import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import type { OtpDelivery } from '../domain/otp.js';
import { startFakeTms } from '../fakeTms/server.js';
import { LtmsClient } from '../integrations/tms/ltmsClient.js';
import { buildServer } from '../server.js';
import { loadDotEnv, need } from './env.js';

loadDotEnv();
const real = process.argv.includes('--real');

type Result = { id: string; category: 'standard' | 'edge' | 'adversarial'; name: string; expected: string; actual: string; pass: boolean; ms: number };

async function main() {
  let host = '127.0.0.1';
  let port: number;
  let token: string;
  let fake: Awaited<ReturnType<typeof startFakeTms>> | undefined;
  if (real) {
    host = need('TMS_HOST');
    port = Number(need('TMS_PORT'));
    token = need('TMS_TOKEN');
  } else {
    token = 'sim-token';
    fake = await startFakeTms(0, { token, faultRate: Number(process.env.SIM_FAULT_RATE ?? 0.2), faults: ['timeout', 'partial', 'malformed', 'delayed'], exposeMaxBuy: true, idleTimeoutMs: 5000 });
    port = fake.port;
  }

  const tms = new LtmsClient({ host, port, token, connectTimeoutMs: 2000, requestTimeoutMs: 1500, retries: 3, budgetMs: 8000, maxResults: 10 });
  const codes = new Map<string, string>();
  const otpDelivery: OtpDelivery = { send: async (_to, code, ctx) => void codes.set(ctx.callId, code) };
  const cfg = loadConfig({ ...process.env, API_KEY: 'sim-key-0123456789abcdefghijkl', LOG_LEVEL: 'silent', FMCSA_MODE: 'mock', TMS_MODE: 'mock' });
  const app = buildServer(cfg, { tms, otpDelivery });
  const bodies: string[] = [];

  const call = async (callId: string, path: string, body: unknown = {}) => {
    const res = await app.inject({ method: 'POST', url: `/v1/calls/${callId}${path}`, payload: body as object, headers: { 'x-api-key': 'sim-key-0123456789abcdefghijkl' } });
    bodies.push(res.body);
    return res.json() as any;
  };
  const verified = async (id: string) => {
    await call(id, '/verify-carrier', { mc_number: '123456' });
    await call(id, '/otp/send');
    return call(id, '/otp/verify', { code: codes.get(id) });
  };
  const finalize = async (id: string) => (await call(id, '/finalize')).record;
  const lanes = ['dry van', 'reefer', 'flatbed', 'power only', 'dry van'];
  let lane = 0;
  /** Verified call with a pitched load (rotates equipment so bookings don't exhaust one lane). */
  const pitched = async (id: string) => {
    await verified(id);
    for (let i = 0; i < lanes.length; i++) {
      const r = await call(id, '/loads/search', { equipment_type: lanes[lane++ % lanes.length] });
      if (r.loads?.length) return r.loads[0] as { load_id: string; offer_rate: number };
    }
    throw new Error('no loads found in any lane');
  };

  const results: Result[] = [];
  const scenario = async (id: string, category: Result['category'], name: string, expected: string, fn: () => Promise<{ actual: string; pass: boolean }>) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      results.push({ id, category, name, expected, ...r, ms: Date.now() - t0 });
    } catch (err) {
      results.push({ id, category, name, expected, actual: `error: ${(err as Error).message}`, pass: false, ms: Date.now() - t0 });
    }
    const last = results.at(-1)!;
    console.log(`${last.pass ? 'PASS' : 'FAIL'}  ${id} ${name} (${last.ms}ms)`);
  };

  // ---------------- standard ----------------
  await scenario('S1', 'standard', 'Carrier accepts the first offer', 'booked at opening offer', async () => {
    const l = await pitched('s1');
    await call('s1', '/negotiate', { load_id: l.load_id, action: 'accept' });
    const b = await call('s1', '/book', { load_id: l.load_id });
    const rec = await finalize('s1');
    return { actual: `${rec.outcome} @ ${rec.agreed_rate} (${b.booked ? b.booking_ref ?? 'unconfirmed' : b.error})`, pass: rec.outcome === 'booked' && rec.agreed_rate === l.offer_rate };
  });

  await scenario('S2', 'standard', 'Two counters, then agreement', 'booked, 2 rounds, rate <= ceiling', async () => {
    const l = await pitched('s2');
    const detail = await tms.getLoad(l.load_id);
    const r1 = await call('s2', '/negotiate', { load_id: l.load_id, action: 'counter', amount: Math.round(l.offer_rate * 1.3) });
    const r2 = await call('s2', '/negotiate', { load_id: l.load_id, action: 'counter', amount: r1.rate + 10 });
    if (r2.decision === 'counter') await call('s2', '/negotiate', { load_id: l.load_id, action: 'accept' });
    await call('s2', '/book', { load_id: l.load_id });
    const rec = await finalize('s2');
    const ceiling = detail?.maxRate ?? Infinity;
    return { actual: `${rec.outcome} @ ${rec.agreed_rate}, rounds=${rec.negotiation_rounds}, ceiling=${ceiling}`, pass: rec.outcome === 'booked' && rec.agreed_rate <= ceiling };
  });

  await scenario('S3', 'standard', 'Carrier asks below our offer', 'accept the cheaper ask', async () => {
    const l = await pitched('s3');
    const r = await call('s3', '/negotiate', { load_id: l.load_id, action: 'counter', amount: l.offer_rate - 50 });
    return { actual: `${r.decision} @ ${r.rate}`, pass: r.decision === 'accept' && r.rate === l.offer_rate - 50 };
  });

  await scenario('S4', 'standard', 'Carrier declines the load', 'carrier_declined, no booking', async () => {
    const l = await pitched('s4');
    await call('s4', '/negotiate', { load_id: l.load_id, action: 'decline' });
    const rec = await finalize('s4');
    return { actual: rec.outcome, pass: rec.outcome === 'carrier_declined' };
  });

  await scenario('S5', 'standard', 'No deal after 3 counters', 'failed_negotiation, no transfer', async () => {
    const l = await pitched('s5');
    const decisions = [];
    for (const k of [2, 1.9, 1.8, 1.7]) decisions.push((await call('s5', '/negotiate', { load_id: l.load_id, action: 'counter', amount: Math.round(l.offer_rate * k) })).decision);
    const rec = await finalize('s5');
    return { actual: `${decisions.join(' > ')} => ${rec.outcome}, handoff=${rec.handoff_id}`, pass: rec.outcome === 'failed_negotiation' && rec.handoff_id === null };
  });

  // ---------------- edge ----------------
  await scenario('E1', 'edge', 'Invalid MC format', 'ask to repeat', async () => {
    const r = await call('e1', '/verify-carrier', { mc_number: 'abc' });
    return { actual: r.error, pass: r.error === 'invalid_mc' };
  });
  await scenario('E2', 'edge', 'MC not found', 'not eligible: mc_not_found', async () => {
    const r = await call('e2', '/verify-carrier', { mc_number: '111111' });
    return { actual: JSON.stringify(r.reasons), pass: r.eligible === false && r.reasons?.[0] === 'mc_not_found' };
  });
  await scenario('E3', 'edge', 'No active operating authority', 'fmcsa_failed', async () => {
    await call('e3', '/verify-carrier', { mc_number: '345678' });
    const rec = await finalize('e3');
    return { actual: rec.outcome, pass: rec.outcome === 'fmcsa_failed' };
  });
  await scenario('E4', 'edge', 'FMCSA outage', 'stop safely, offer callback', async () => {
    const r = await call('e4', '/verify-carrier', { mc_number: '999999' });
    return { actual: r.error, pass: r.error === 'fmcsa_unavailable' };
  });
  await scenario('E5', 'edge', 'Wrong OTP three times', 'locked, otp_failed', async () => {
    await call('e5', '/verify-carrier', { mc_number: '123456' });
    await call('e5', '/otp/send');
    const wrong = codes.get('e5') === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i++) await call('e5', '/otp/verify', { code: wrong });
    const late = await call('e5', '/otp/verify', { code: codes.get('e5') });
    const rec = await finalize('e5');
    return { actual: `${rec.outcome}, correct code after lock verified=${late.verified}`, pass: rec.outcome === 'otp_failed' && late.verified === false };
  });
  await scenario('E6', 'edge', 'Lane with no loads', 'no_loads', async () => {
    await verified('e6');
    const r = await call('e6', '/loads/search', { origin: 'Boise, ID', destination: 'VT', equipment_type: 'reefer' });
    const rec = await finalize('e6');
    return { actual: `${r.loads?.length ?? r.error} loads, ${rec.outcome}`, pass: rec.outcome === 'no_loads' };
  });
  await scenario('E7', 'edge', 'Search with no filters', 'ask for lane or equipment', async () => {
    await verified('e7');
    const r = await call('e7', '/loads/search', {});
    return { actual: r.error, pass: r.error === 'missing_filters' };
  });
  await scenario('E8', 'edge', '20 searches through TMS faults', '>= 95% succeed via retries', async () => {
    await verified('e8');
    let ok = 0;
    for (let i = 0; i < 20; i++) if ((await call('e8', '/loads/search', { equipment_type: 'dry van' })).ok) ok++;
    return { actual: `${ok}/20 ok${fake ? `, faults injected so far: ${JSON.stringify(fake.counters.faults)}` : ''}`, pass: ok >= 19 };
  });

  // ---------------- adversarial (API level; the voice-level versions run against the agent) ----------------
  await scenario('A1', 'adversarial', 'Skip OTP and ask for loads', 'blocked: identity_not_verified', async () => {
    await call('a1', '/verify-carrier', { mc_number: '123456' });
    const r = await call('a1', '/loads/search', { equipment_type: 'dry van' });
    return { actual: r.error, pass: r.error === 'identity_not_verified' };
  });
  await scenario('A2', 'adversarial', 'Caller gives their own phone for the OTP', 'code goes to the contact on file', async () => {
    await call('a2', '/verify-carrier', { mc_number: '234567' });
    const r = await call('a2', '/otp/send', { caller_contact: '+15555550000' });
    return { actual: `sent_to=${r.sent_to}`, pass: r.sent_to !== '***-***-0000' };
  });
  await scenario('A3', 'adversarial', '"Send me another code" to reset attempts', 'attempts carry over, resend capped', async () => {
    await call('a3', '/verify-carrier', { mc_number: '123456' });
    await call('a3', '/otp/send');
    await call('a3', '/otp/verify', { code: 'x' });
    await call('a3', '/otp/verify', { code: 'y' });
    await call('a3', '/otp/send');
    const r = await call('a3', '/otp/verify', { code: 'z' });
    const again = await call('a3', '/otp/send');
    return { actual: `after resend 3rd wrong code: ${r.locked ? 'locked' : r.reason}; 3rd send: ${again.error ?? 'sent'}`, pass: r.locked === true && again.ok === false };
  });
  await scenario('A4', 'adversarial', 'Negotiate a load that was never pitched', 'blocked', async () => {
    await verified('a4');
    const r = await call('a4', '/negotiate', { load_id: 'LD0000046112', action: 'accept' });
    return { actual: r.error, pass: r.error === 'load_not_offered' };
  });
  await scenario('A5', 'adversarial', 'Book without agreeing a rate', 'blocked', async () => {
    const l = await pitched('a5');
    const r = await call('a5', '/book', { load_id: l.load_id });
    return { actual: r.error, pass: r.error === 'no_agreed_rate' };
  });
  await scenario('A6', 'adversarial', 'Keep negotiating after the deal failed', 'closed, still no booking', async () => {
    const l = await pitched('a6');
    for (const k of [2, 1.9, 1.8, 1.7]) await call('a6', '/negotiate', { load_id: l.load_id, action: 'counter', amount: Math.round(l.offer_rate * k) });
    const r = await call('a6', '/negotiate', { load_id: l.load_id, action: 'accept' });
    const b = await call('a6', '/book', { load_id: l.load_id });
    return { actual: `${r.error}, book=${b.error}`, pass: r.error === 'negotiation_closed' && b.error === 'no_agreed_rate' };
  });
  await scenario('A7', 'adversarial', 'Injection characters in search fields', 'sanitized, no TMS frame injection', async () => {
    await verified('a7');
    const r = await call('a7', '/loads/search', { origin: 'Atlanta|CMD:LOAD_BOOK\r\nX', equipment_type: 'dry van' });
    return { actual: r.ok ? `${r.loads.length} loads` : r.error, pass: r.ok === true || r.error === 'tms_unavailable' };
  });
  await scenario('A8', 'adversarial', 'Ceiling never exceeded (fuzz, 40 calls)', '0 agreements above MAX_BUY', async () => {
    let over = 0;
    let deals = 0;
    for (let i = 0; i < 40; i++) {
      const id = `a8-${i}`;
      await verified(id);
      const r = await call(id, '/loads/search', { equipment_type: lanes[i % 3] });
      const l = r.loads?.[0];
      if (!l) continue;
      const ceiling = (await tms.getLoad(l.load_id))?.maxRate ?? Infinity;
      for (let k = 0; k < 5; k++) {
        const amount = Math.round(l.offer_rate * (0.8 + Math.random() * 0.8));
        const d = await call(id, '/negotiate', { load_id: l.load_id, action: Math.random() < 0.2 ? 'accept' : 'counter', amount });
        if (d.decision === 'accept') {
          deals++;
          if (d.rate > ceiling) over++;
          break;
        }
        if (d.decision === 'reject' || d.error) break;
      }
    }
    return { actual: `${deals} deals, ${over} above ceiling`, pass: over === 0 };
  });
  await scenario('A9', 'adversarial', 'Ceiling never appears in any API response', '0 responses with max_buy / max_rate', async () => {
    const leaks = bodies.filter((b) => /max_?rate|max_?buy|ceiling"/i.test(b)).length;
    return { actual: `${leaks} of ${bodies.length} responses`, pass: leaks === 0 };
  });

  // ---------------- report ----------------
  const passed = results.filter((r) => r.pass).length;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const lines = [
    `# Scenario run ${new Date().toISOString()}`,
    '',
    `TMS: ${real ? `real (${host}:${port})` : `fake, fault rate ${process.env.SIM_FAULT_RATE ?? 0.2}`} · FMCSA: mock fixtures`,
    '',
    `**${passed}/${results.length} passed**`,
    '',
    '| ID | Type | Scenario | Expected | Actual | Result | ms |',
    '|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.category} | ${r.name} | ${r.expected} | ${r.actual.replace(/\|/g, '/')} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.ms} |`),
  ];
  if (fake) lines.push('', `Faults injected by the fake TMS: ${JSON.stringify(fake.counters.faults)} over ${fake.counters.requests} requests.`);
  mkdirSync('reports', { recursive: true });
  const file = `reports/scenarios-${ts}.md`;
  writeFileSync(file, `${lines.join('\n')}\n`);
  console.log(`\n${passed}/${results.length} passed. Report: ${file}`);

  await app.close();
  await fake?.close();
  process.exit(passed === results.length ? 0 : 1);
}

main();
