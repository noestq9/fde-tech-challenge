import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

describe('setOpsStatus via API v2', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to SQL when the table has no primary key (409)', async () => {
    vi.stubEnv('HAPPYROBOT_API_KEY', 'hr_test');
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method, body: init.body as string });
      if (init.method === 'PATCH') return new Response('{"error":"Conflict","message":"This table does not have a primary key"}', { status: 409 });
      return new Response('{"command":"UPDATE","rowCount":1}', { status: 200 });
    });
    const { setOpsStatus } = await import('../lib/twin');
    await setOpsStatus('run_123-abc', 'confirmed');
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST']);
    expect(calls[1]!.url).toMatch(/\/twin\/sql$/);
    expect(JSON.parse(calls[1]!.body!).sql).toBe("UPDATE carrier_calls SET ops_status = 'confirmed' WHERE run_id = 'run_123-abc'");
  });

  it('refuses run ids that could break out of the SQL string', async () => {
    const { opsStatusSql } = await import('../lib/twin');
    expect(() => opsStatusSql("x' OR '1'='1", 'confirmed')).toThrow();
  });
});
