import { z } from 'zod';
import { CircuitBreaker, retry, withTimeout } from '../lib/resilience.js';

// FMCSA QCMobile API (https://mobile.fmcsa.dot.gov/QCDevsite/). Requires a free webKey.
// A carrier is eligible when it is allowed to operate and has active common or contract authority.

export interface CarrierProfile {
  mcNumber: string;
  dotNumber?: string;
  legalName?: string;
  dbaName?: string;
  city?: string;
  state?: string;
  /** Contact on file, if FMCSA returns one. Used as the OTP destination. */
  phone?: string;
}

export type FmcsaResult =
  | { status: 'eligible'; carrier: CarrierProfile }
  | { status: 'not_eligible'; carrier: CarrierProfile; reasons: string[] }
  | { status: 'not_found'; mcNumber: string }
  | { status: 'unavailable'; mcNumber: string; error: string };

export interface FmcsaClient {
  verifyMc(mcNumber: string): Promise<FmcsaResult>;
}

export function normalizeMc(input: string): string | null {
  const digits = String(input).replace(/^\s*MC[-\s]*/i, '').replace(/\D/g, '');
  return digits.length >= 1 && digits.length <= 8 ? digits.replace(/^0+(?=\d)/, '') : null;
}

const carrierSchema = z
  .object({
    allowedToOperate: z.string().optional(),
    dotNumber: z.union([z.number(), z.string()]).optional(),
    legalName: z.string().nullish(),
    dbaName: z.string().nullish(),
    phyCity: z.string().nullish(),
    phyState: z.string().nullish(),
    statusCode: z.string().nullish(),
    telephone: z.string().nullish(),
  })
  .passthrough();

class HttpStatusError extends Error {
  constructor(public status: number) {
    super(`FMCSA HTTP ${status}`);
  }
}

export class LiveFmcsaClient implements FmcsaClient {
  private breaker = new CircuitBreaker('fmcsa', 5, 30_000);

  constructor(private readonly baseUrl: string, private readonly webKey: string, private readonly timeoutMs: number) {}

  async verifyMc(mcNumber: string): Promise<FmcsaResult> {
    try {
      const byDocket = await this.get(`/carriers/docket-number/${encodeURIComponent(mcNumber)}`);
      const first = Array.isArray(byDocket?.content) ? byDocket.content[0]?.carrier : byDocket?.content?.carrier;
      if (!first) return { status: 'not_found', mcNumber };
      const c = carrierSchema.parse(first);
      const carrier: CarrierProfile = {
        mcNumber,
        dotNumber: c.dotNumber != null ? String(c.dotNumber) : undefined,
        legalName: c.legalName ?? undefined,
        dbaName: c.dbaName ?? undefined,
        city: c.phyCity ?? undefined,
        state: c.phyState ?? undefined,
        phone: c.telephone ?? undefined,
      };

      const reasons: string[] = [];
      if (c.allowedToOperate !== 'Y') reasons.push('not_allowed_to_operate');
      if (c.statusCode && c.statusCode !== 'A') reasons.push('inactive_usdot');

      if (carrier.dotNumber) {
        const auth = await this.get(`/carriers/${carrier.dotNumber}/authority`);
        const list: any[] = Array.isArray(auth?.content) ? auth.content : auth?.content ? [auth.content] : [];
        const active = list.some((a) => {
          const ca = a?.carrierAuthority ?? a;
          return ca?.commonAuthorityStatus === 'A' || ca?.contractAuthorityStatus === 'A';
        });
        if (!active) reasons.push('no_active_operating_authority');
      }

      return reasons.length ? { status: 'not_eligible', carrier, reasons } : { status: 'eligible', carrier };
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 404) return { status: 'not_found', mcNumber };
      return { status: 'unavailable', mcNumber, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async get(path: string): Promise<any> {
    const url = `${this.baseUrl}${path}?webKey=${encodeURIComponent(this.webKey)}`;
    return this.breaker.exec(() =>
      retry(
        () =>
          withTimeout('fmcsa', this.timeoutMs, async (signal) => {
            const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
            if (!res.ok) throw new HttpStatusError(res.status);
            return res.json();
          }),
        { retries: 2, isRetryable: (e) => !(e instanceof HttpStatusError && e.status < 500) },
      ),
    );
  }
}

/** Fixtures for demos and tests. MC numbers chosen to exercise each branch. */
export class MockFmcsaClient implements FmcsaClient {
  static readonly fixtures: Record<string, FmcsaResult> = {
    '123456': { status: 'eligible', carrier: { mcNumber: '123456', dotNumber: '3456789', legalName: 'Blue Ridge Transport LLC', city: 'Atlanta', state: 'GA', phone: '+14045550101' } },
    '234567': { status: 'eligible', carrier: { mcNumber: '234567', dotNumber: '4567890', legalName: 'Lakeshore Reefer Inc', city: 'Milwaukee', state: 'WI' } },
    '345678': { status: 'not_eligible', carrier: { mcNumber: '345678', dotNumber: '5678901', legalName: 'Revoked Hauling Co' }, reasons: ['no_active_operating_authority'] },
    '456789': { status: 'not_eligible', carrier: { mcNumber: '456789', dotNumber: '6789012', legalName: 'Grounded Freight LLC' }, reasons: ['not_allowed_to_operate'] },
    '999999': { status: 'unavailable', mcNumber: '999999', error: 'simulated FMCSA outage' },
  };

  async verifyMc(mcNumber: string): Promise<FmcsaResult> {
    return MockFmcsaClient.fixtures[mcNumber] ?? { status: 'not_found', mcNumber };
  }
}
