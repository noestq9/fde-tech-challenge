import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeTms, type FaultKind } from '../src/fakeTms/server.js';
import { LtmsClient } from '../src/integrations/tms/ltmsClient.js';
import { TmsError } from '../src/integrations/tms/types.js';

// The real client against the fake TCP server, with faults forced one by one.

let fake: Awaited<ReturnType<typeof startFakeTms>>;
let client: LtmsClient;

async function setup(opts: { forced?: FaultKind[]; exposeMaxBuy?: boolean; token?: string; retries?: number } = {}) {
  fake = await startFakeTms(0, { token: 'secret', faultRate: 0, faults: [], exposeMaxBuy: opts.exposeMaxBuy ?? true, idleTimeoutMs: 1500, forced: opts.forced });
  client = new LtmsClient({
    host: '127.0.0.1', port: fake.port, token: opts.token ?? 'secret', connectTimeoutMs: 500, requestTimeoutMs: 300,
    retries: opts.retries ?? 3, budgetMs: 4000, maxResults: 10,
  });
}

afterEach(async () => {
  await fake?.close();
});

describe('LtmsClient against the fake TMS', () => {
  describe('happy path', () => {
    beforeEach(() => setup());

    it('pings with DEBUG_ECHO and counts fields (encoder conformance)', async () => {
      expect(await client.ping('HELLO', { X: '1', Y: '2', Z: '3' })).toEqual({ fieldsParsed: 6, msg: 'HELLO' });
    });

    it('searches by state and equipment', async () => {
      const loads = await client.searchLoads({ originState: 'GA', destinationState: 'TX', equipmentType: 'DRY_VAN' });
      expect(loads.map((l) => l.loadId)).toEqual(['LD0000045821', 'LD0000045903']);
    });

    it('city match is forgiving (Miami also finds Miami Gardens)', async () => {
      const loads = await client.searchLoads({ originCity: 'Miami', equipmentType: 'REEFER' });
      expect(loads.map((l) => l.origin)).toEqual(['Miami, FL', 'Miami Gardens, FL']);
    });

    it('returns null for an unknown load', async () => {
      expect(await client.getLoad('LD9999999999')).toBeNull();
    });

    it('books once, then reports the load as not available', async () => {
      const b = await client.bookLoad('LD0000045821', '872144', 1900);
      expect(b).toMatchObject({ status: 'BOOKED', bookingRef: expect.stringMatching(/^BR\d{14}$/) });
      const fresh = new LtmsClient({ host: '127.0.0.1', port: fake.port, token: 'secret', connectTimeoutMs: 500, requestTimeoutMs: 300, retries: 1, budgetMs: 2000, maxResults: 10 });
      await expect(fresh.bookLoad('LD0000045821', '872144', 1900)).rejects.toMatchObject({ kind: 'not_available' });
      expect((await client.getLoad('LD0000045821'))?.status).toBe('BOOKED');
    });

    it('maps INVALID_RATE', async () => {
      await expect(client.bookLoad('LD0000046112', '872144', 99999)).rejects.toMatchObject({ kind: 'rate_rejected' });
    });
  });

  it('fails fast on a bad token without retrying', async () => {
    await setup({ token: 'wrong' });
    await expect(client.searchLoads({ originState: 'GA' })).rejects.toMatchObject({ kind: 'auth' });
    expect(fake.counters.requests).toBe(1);
  });

  it('models a token without the MAX_BUY flag as maxRate null', async () => {
    await setup({ exposeMaxBuy: false });
    expect((await client.getLoad('LD0000045821'))?.maxRate).toBeNull();
  });

  for (const fault of ['timeout', 'partial', 'malformed', 'delayed'] as FaultKind[]) {
    it(`recovers from a ${fault} fault on a read`, async () => {
      await setup({ forced: [fault] });
      const t0 = Date.now();
      const load = await client.getLoad('LD0000046112');
      expect(load?.maxRate).toBe(3080);
      // "delayed" returns a complete answer: we must not wait for the socket to close.
      if (fault === 'delayed') expect(Date.now() - t0).toBeLessThan(500);
    });
  }

  it('gives up with a clear error when every attempt faults', async () => {
    await setup({ forced: ['partial', 'malformed', 'partial', 'malformed'] });
    const err = await client.searchLoads({ originState: 'GA' }).catch((e) => e);
    expect(err).toBeInstanceOf(TmsError);
    expect(err.kind).toBe('malformed');
  });

  it('booking: lost response + ALREADY_BOOKED on retry means we booked it (BOOKED_UNCONFIRMED)', async () => {
    // The fake commits the booking and then drops the response.
    await setup({ forced: ['partial'] });
    const b = await client.bookLoad('LD0000047001', '872144', 2200);
    expect(b).toEqual({ loadId: 'LD0000047001', status: 'BOOKED_UNCONFIRMED', bookingRef: null });
  });

  it('booking: a clean first-attempt ALREADY_BOOKED means someone else has it', async () => {
    await setup();
    await client.bookLoad('LD0000047002', '872144', 2100);
    const other = new LtmsClient({ host: '127.0.0.1', port: fake.port, token: 'secret', connectTimeoutMs: 500, requestTimeoutMs: 300, retries: 2, budgetMs: 2000, maxResults: 10 });
    await expect(other.bookLoad('LD0000047002', '872144', 2100)).rejects.toMatchObject({ kind: 'not_available' });
  });

  it('booking: every attempt ambiguous ends as booking_unknown, never as a silent success', async () => {
    await setup({ forced: ['timeout', 'timeout', 'timeout', 'timeout'], retries: 1 });
    await expect(client.bookLoad('LD0000047003', '872144', 3000)).rejects.toMatchObject({ kind: 'booking_unknown' });
  });
});
