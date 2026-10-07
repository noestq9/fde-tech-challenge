import { describe, expect, it, beforeEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import type { OtpDelivery } from '../src/domain/otp.js';

const API_KEY = 'test-key-0123456789abcdefghij';
let codes: string[];
let app: ReturnType<typeof buildServer>;
const bodies: string[] = [];

beforeEach(() => {
  codes = [];
  const otpDelivery: OtpDelivery = { send: async (_to, code) => void codes.push(code) };
  app = buildServer(loadConfig({ API_KEY, LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), { otpDelivery });
});

async function call(path: string, payload?: unknown, key = API_KEY) {
  const res = await app.inject({ method: 'POST', url: path, payload: payload ?? {}, headers: { 'x-api-key': key } });
  bodies.push(res.body);
  return { status: res.statusCode, json: res.json() as any };
}

async function verified(callId: string, mc = '123456') {
  await call(`/v1/calls/${callId}/verify-carrier`, { mc_number: `MC-${mc}` });
  await call(`/v1/calls/${callId}/otp/send`);
  return call(`/v1/calls/${callId}/otp/verify`, { code: codes.at(-1) });
}

describe('API', () => {
  it('rejects requests without the API key, but serves /health', async () => {
    expect((await call('/v1/calls/x/verify-carrier', { mc_number: '123456' }, 'wrong')).status).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('runs the happy path: verify, OTP, search, negotiate, book, summary', async () => {
    const v = await call('/v1/calls/c1/verify-carrier', { mc_number: 'MC 123456' });
    expect(v.json).toMatchObject({ eligible: true, carrier_name: 'Blue Ridge Transport LLC' });

    const sent = await call('/v1/calls/c1/otp/send');
    expect(sent.json).toMatchObject({ sent: true, channel: 'sms', sent_to: '***-***-0101' });
    expect(JSON.stringify(sent.json)).not.toContain(codes[0]);

    expect((await call('/v1/calls/c1/otp/verify', { code: codes[0] })).json).toMatchObject({ verified: true });

    const search = await call('/v1/calls/c1/loads/search', { origin: 'Chicago', equipment_type: 'dry_van' });
    expect(search.json.loads[0].loadId).toBe('HR10001');

    expect((await call('/v1/calls/c1/negotiate', { load_id: 'HR10001', action: 'counter', amount: 2600 })).json).toMatchObject({ decision: 'counter', rate: 2220 });
    expect((await call('/v1/calls/c1/negotiate', { load_id: 'HR10001', action: 'counter', amount: 2300 })).json).toMatchObject({ decision: 'accept', rate: 2300 });

    const book = await call('/v1/calls/c1/book', { load_id: 'HR10001' });
    expect(book.json).toMatchObject({ booked: true, rate: 2300 });

    const fin = await call('/v1/calls/c1/finalize', { sentiment: 'positive' });
    expect(fin.json.record).toMatchObject({ outcome: 'booked', mc_number: '123456', agreed_rate: 2300, negotiation_rounds: 2, otp_verified: true });
  });

  it('blocks load search until the OTP is verified', async () => {
    await call('/v1/calls/c2/verify-carrier', { mc_number: '123456' });
    const r = await call('/v1/calls/c2/loads/search', { origin: 'Chicago' });
    expect(r.json).toMatchObject({ ok: false, error: 'identity_not_verified' });
  });

  it('will not send an OTP before FMCSA passes', async () => {
    await call('/v1/calls/c3/verify-carrier', { mc_number: '345678' });
    expect((await call('/v1/calls/c3/otp/send')).json).toMatchObject({ ok: false, error: 'carrier_not_verified' });
  });

  it('ends on inactive authority and logs fmcsa_failed', async () => {
    const r = await call('/v1/calls/c4/verify-carrier', { mc_number: '345678' });
    expect(r.json).toMatchObject({ eligible: false, reasons: ['no_active_operating_authority'] });
    expect((await call('/v1/calls/c4/finalize')).json.record.outcome).toBe('fmcsa_failed');
  });

  it('handles FMCSA outage without continuing', async () => {
    const r = await call('/v1/calls/c5/verify-carrier', { mc_number: '999999' });
    expect(r.json).toMatchObject({ ok: false, error: 'fmcsa_unavailable' });
  });

  it('sends OTP to contact on file, ignoring a caller-provided number', async () => {
    await call('/v1/calls/c6/verify-carrier', { mc_number: '234567' });
    const r = await call('/v1/calls/c6/otp/send', { caller_contact: '+15555550000' });
    expect(r.json).toMatchObject({ channel: 'email', sent_to: 'd***@lakeshore-reefer.example' });
  });

  it('refuses to negotiate a load that was not offered', async () => {
    await verified('c7');
    const r = await call('/v1/calls/c7/negotiate', { load_id: 'HR10003', action: 'accept' });
    expect(r.json).toMatchObject({ ok: false, error: 'load_not_offered' });
  });

  it('refuses to book without an agreed rate', async () => {
    await verified('c8');
    await call('/v1/calls/c8/loads/search', { origin: 'Chicago' });
    expect((await call('/v1/calls/c8/book', { load_id: 'HR10001' })).json).toMatchObject({ ok: false, error: 'no_agreed_rate' });
  });

  it('maps a TMS timeout to a safe response', async () => {
    await verified('c9');
    const r = await call('/v1/calls/c9/loads/search', { origin: 'timeout' });
    expect(r.json).toMatchObject({ ok: false, error: 'tms_unavailable' });
    expect((await call('/v1/calls/c9/finalize')).json.record.integration_errors).toBe(1);
  });

  it('logs failed_negotiation after three counters', async () => {
    await verified('c10');
    await call('/v1/calls/c10/loads/search', { origin: 'Chicago', equipment_type: 'dry_van' });
    for (const amount of [3000, 2900, 2800, 2700]) await call('/v1/calls/c10/negotiate', { load_id: 'HR10001', action: 'counter', amount });
    expect((await call('/v1/calls/c10/finalize')).json.record.outcome).toBe('failed_negotiation');
  });

  it('validates input', async () => {
    expect((await call('/v1/calls/c11/negotiate', { load_id: 'HR10001', action: 'counter' })).status).toBe(400);
  });

  it('never returns max_rate in any response', () => {
    for (const b of bodies) expect(b).not.toMatch(/max_?rate/i);
  });
});
