import { describe, expect, it, beforeEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildServer, parseLocation } from '../src/server.js';
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

    const search = await call('/v1/calls/c1/loads/search', { origin: 'Chicago, IL', equipment_type: 'dry van' });
    // LD0000047001: listed 2600, MAX_BUY 2340 -> opening min(2600, 2340*0.9) = 2105
    expect(search.json.loads[0]).toMatchObject({ load_id: 'LD0000047001', offer_rate: 2105, origin: 'Chicago, IL' });

    expect((await call('/v1/calls/c1/negotiate', { load_id: 'LD0000047001', action: 'counter', amount: 2600 })).json).toMatchObject({ decision: 'counter', rate: 2185 });
    expect((await call('/v1/calls/c1/negotiate', { load_id: 'LD0000047001', action: 'counter', amount: 2250 })).json).toMatchObject({ decision: 'accept', rate: 2250 });

    const book = await call('/v1/calls/c1/book', { load_id: 'LD0000047001' });
    expect(book.json).toMatchObject({ booked: true, rate: 2250 });
    expect(book.json.booking_ref).toMatch(/^BR\d{14}$/);

    const fin = await call('/v1/calls/c1/finalize', { sentiment: 'positive' });
    expect(fin.json.record).toMatchObject({ outcome: 'booked', mc_number: '123456', agreed_rate: 2250, loadboard_rate: 2600, opening_offer: 2105, negotiation_rounds: 2, otp_verified: true, booking_status: 'BOOKED' });
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
    const r = await call('/v1/calls/c7/negotiate', { load_id: 'LD0000047003', action: 'accept' });
    expect(r.json).toMatchObject({ ok: false, error: 'load_not_offered' });
  });

  it('refuses to book without an agreed rate', async () => {
    await verified('c8');
    await call('/v1/calls/c8/loads/search', { origin: 'Chicago' });
    expect((await call('/v1/calls/c8/book', { load_id: 'LD0000047001' })).json).toMatchObject({ ok: false, error: 'no_agreed_rate' });
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
    for (const amount of [3000, 2900, 2800, 2700]) await call('/v1/calls/c10/negotiate', { load_id: 'LD0000047001', action: 'counter', amount });
    expect((await call('/v1/calls/c10/finalize')).json.record.outcome).toBe('failed_negotiation');
  });

  it('validates input', async () => {
    expect((await call('/v1/calls/c11/negotiate', { load_id: 'LD0000047001', action: 'counter' })).status).toBe(400);
  });

  it('asks for filters when the carrier gave none', async () => {
    await verified('c12');
    expect((await call('/v1/calls/c12/loads/search', {})).json).toMatchObject({ ok: false, error: 'missing_filters' });
  });

  it('never pitches a load above its ceiling, and the opening never leaks the listed rate', async () => {
    await verified('c13');
    const r = await call('/v1/calls/c13/loads/search', { origin: 'Miami' });
    for (const l of r.json.loads) {
      expect(l).not.toHaveProperty('loadboard_rate');
      expect(l.offer_rate).toBeLessThan(3080 + 1);
    }
  });

  it('never returns max_rate in any response', () => {
    for (const b of bodies) expect(b).not.toMatch(/max_?rate|max_?buy|ceiling"/i);
  });
});

describe('health', () => {
  it('is public with a trailing slash or query string', async () => {
    for (const url of ['/health', '/health/', '/health?probe=1']) expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
  });
  it('treats empty or "null" optional params from workflow templates as absent', async () => {
    await verified('e1');
    const search = await call('/v1/calls/e1/loads/search', { origin: 'TX', destination: '', equipment_type: 'null' });
    expect(search.json).toMatchObject({ ok: true });
    const loadId = search.json.loads[0].load_id;
    expect((await call('/v1/calls/e1/negotiate', { load_id: loadId, action: 'accept', amount: '' })).json).toMatchObject({ decision: 'accept' });
  });
  it('still hides unknown routes behind auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/healt' })).statusCode).toBe(401);
  });
});

describe('OTP demo contact', () => {
  it('sends every code to OTP_DEMO_CONTACT, even for carriers with no contact on file', async () => {
    const sent: string[] = [];
    const demo = buildServer(loadConfig({ API_KEY, LOG_LEVEL: 'silent', OTP_DEMO_CONTACT: '+15550001234' } as NodeJS.ProcessEnv), {
      otpDelivery: { send: async (to) => void sent.push(to.address) },
      fmcsa: { verifyMc: async (mc) => ({ status: 'eligible', carrier: { mcNumber: mc, legalName: 'No Phone LLC' } }) },
    });
    const h = { 'x-api-key': API_KEY };
    await demo.inject({ method: 'POST', url: '/v1/calls/d1/verify-carrier', payload: { mc_number: '777777' }, headers: h });
    const r = (await demo.inject({ method: 'POST', url: '/v1/calls/d1/otp/send', payload: {}, headers: h })).json();
    expect(r).toMatchObject({ sent: true, channel: 'sms', sent_to: '***-***-1234' });
    expect(sent).toEqual(['+15550001234']);
    expect((await demo.inject({ method: 'POST', url: '/v1/calls/d1/finalize', payload: {}, headers: h })).json().record.otp_source).toBe('demo');
  });

  it('refuses to start in production with a demo contact', () => {
    expect(() => loadConfig({ API_KEY, NODE_ENV: 'production', OTP_DEMO_CONTACT: '+15550001234' } as NodeJS.ProcessEnv)).toThrow(/OTP_DEMO_CONTACT/);
  });
});

describe('Simulated OTP (OTP_DELIVERY=simulated)', () => {
  const h = { 'x-api-key': API_KEY };
  const sim = () =>
    buildServer(loadConfig({ API_KEY, LOG_LEVEL: 'silent', OTP_DELIVERY: 'simulated' } as NodeJS.ProcessEnv), {
      fmcsa: { verifyMc: async (mc) => ({ status: 'eligible', carrier: { mcNumber: mc, legalName: 'No Phone LLC' } }) },
    });
  const post = (a: ReturnType<typeof sim>, url: string, payload: object = {}) => a.inject({ method: 'POST', url, payload, headers: h }).then((r) => r.json());

  it('accepts 1218 without any contact on file and unlocks the load search', async () => {
    const a = sim();
    await post(a, '/v1/calls/s1/verify-carrier', { mc_number: '777777' });
    expect(await post(a, '/v1/calls/s1/otp/send')).toMatchObject({ ok: true, sent: true, sent_to: 'the phone number on file' });
    expect(await post(a, '/v1/calls/s1/otp/verify', { code: '1218' })).toMatchObject({ verified: true });
    expect((await post(a, '/v1/calls/s1/finalize')).record.otp_source).toBe('simulated');
  });

  it('rejects any other code and locks after 3 misses, even with 1218 afterwards', async () => {
    const a = sim();
    await post(a, '/v1/calls/s2/verify-carrier', { mc_number: '777777' });
    await post(a, '/v1/calls/s2/otp/send');
    expect(await post(a, '/v1/calls/s2/otp/verify', { code: '1234' })).toMatchObject({ verified: false, reason: 'mismatch', attempts_left: 2 });
    await post(a, '/v1/calls/s2/otp/verify', { code: '0000' });
    expect(await post(a, '/v1/calls/s2/otp/verify', { code: '9999' })).toMatchObject({ verified: false, locked: true });
    expect(await post(a, '/v1/calls/s2/otp/verify', { code: '1218' })).toMatchObject({ verified: false });
    expect(await post(a, '/v1/calls/s2/loads/search', { origin: 'TX' })).toMatchObject({ ok: false, error: 'identity_not_verified' });
  });

  it('accepts 1218 even if the agent skipped send_verification_code', async () => {
    const a = sim();
    await post(a, '/v1/calls/s3/verify-carrier', { mc_number: '777777' });
    expect(await post(a, '/v1/calls/s3/otp/verify', { code: '1218' })).toMatchObject({ verified: true });
  });

  it('still needs an eligible carrier before any code works', async () => {
    const a = sim();
    const r = await post(a, '/v1/calls/s4/otp/verify', { code: '1218' });
    expect(r).toMatchObject({ verified: false, reason: 'no_code' });
    expect(r.agent_guidance).toMatch(/send_verification_code/);
  });

  it('needs ALLOW_OTP_DEMO=true in production', () => {
    const env = { API_KEY, NODE_ENV: 'production', OTP_DELIVERY: 'simulated' };
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/ALLOW_OTP_DEMO/);
    expect(loadConfig({ ...env, ALLOW_OTP_DEMO: 'true' } as NodeJS.ProcessEnv).OTP_SIMULATED_CODE).toBe('1218');
  });
});

describe('parseLocation', () => {
  it.each([
    ['Dallas, TX', { city: 'Dallas', state: 'TX' }],
    ['Dallas TX', { city: 'Dallas', state: 'TX' }],
    ['Dallas, Texas', { city: 'Dallas', state: 'TX' }],
    ['Dallas Texas', { city: 'Dallas', state: 'TX' }],
    ['Texas', { state: 'TX' }],
    ['tx', { state: 'TX' }],
    ['New York', { state: 'NY' }],
    ['Kansas City, Missouri', { city: 'Kansas City', state: 'MO' }],
    ['Atlanta, GA, USA', { city: 'Atlanta', state: 'GA' }],
    ['Memphis', { city: 'Memphis' }],
    ['Southern California', { state: 'CA' }],
    ['SoCal', { state: 'CA' }],
    ['upstate New York', { state: 'NY' }],
    ['West Virginia', { state: 'WV' }],
    ['South Carolina', { state: 'SC' }],
    ['anywhere', {}],
    ["doesn't matter", {}],
    ['open', {}],
  ])('%s', (input, expected) => expect(parseLocation(input)).toEqual(expected));
});

describe('Destination with no loads', () => {
  it('searches a region as its state and falls back to the origin when nothing goes there', async () => {
    await verified('dst0');
    const r = await call('/v1/calls/dst0/loads/search', { origin: 'Houston, TX', destination: 'Southern California', equipment_type: 'dry van' });
    expect(r.json).toMatchObject({ ok: true, destination_relaxed: true });
    expect(r.json.loads.map((l: { load_id: string }) => l.load_id)).toContain('LD00925');
  });

  it('falls back to loads from the origin and says so', async () => {
    await verified('dst1');
    const r = await call('/v1/calls/dst1/loads/search', { origin: 'Houston, TX', destination: 'Boise, Idaho' });
    expect(r.json).toMatchObject({ ok: true, destination_relaxed: true });
    expect(r.json.loads.length).toBeGreaterThan(0);
    expect(r.json.agent_guidance).toMatch(/Nothing is going to Boise, Idaho/);
  });

  it('asks for origin or equipment when only an unmatched destination was given', async () => {
    await verified('dst2');
    const r = await call('/v1/calls/dst2/loads/search', { destination: 'Boise, ID' });
    expect(r.json).toMatchObject({ ok: true, loads: [] });
    expect(r.json.agent_guidance).toMatch(/Ask where they are now/);
  });

  it('a later successful search clears the no_loads outcome', async () => {
    await verified('dst3');
    await call('/v1/calls/dst3/loads/search', { origin: 'Boise, ID' });
    expect((await call('/v1/calls/dst3/loads/search', { origin: 'Houston, TX' })).json.loads.length).toBeGreaterThan(0);
    const rec = (await app.inject({ method: 'GET', url: '/v1/calls/dst3', headers: { 'x-api-key': API_KEY } })).json().record;
    expect(rec.outcome).not.toBe('no_loads');
  });
});
