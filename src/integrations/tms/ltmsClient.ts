import { appendFile } from 'node:fs/promises';
import { CircuitBreaker, CircuitOpenError, sleep } from '../../lib/resilience.js';
import {
  MalformedResponseError, ProtocolEncodeError, datetime, encodeRequest, int, optionalInt, optionalText, parseResponse,
  pattern, redact, text, type Command, type TmsRecord,
} from './protocol.js';
import { FramingError, PartialResponseError, TmsTimeoutError, TransportError, sendRequest } from './transport.js';
import { TmsError, type BookingResult, type Load, type LoadSearchQuery, type LoadSummary, type TmsClient } from './types.js';

export interface LtmsOptions {
  host: string;
  port: number;
  token: string;
  connectTimeoutMs: number;
  /** Per-attempt deadline. */
  requestTimeoutMs: number;
  retries: number;
  /** Total time budget per operation, including retries. The caller is on a live phone call. */
  budgetMs: number;
  maxResults: number;
  /** Optional JSONL file where every booking attempt is recorded (survives restarts). */
  bookingJournalPath?: string;
  logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
}

type Outcome = { kind: 'ok'; records: TmsRecord[] } | { kind: 'error'; code: string; message: string };

const RETRYABLE = [TransportError, TmsTimeoutError, PartialResponseError, FramingError, MalformedResponseError];
const isFault = (e: unknown) => RETRYABLE.some((C) => e instanceof C);

export class LtmsClient implements TmsClient {
  private breaker = new CircuitBreaker('ltms', 6, 20_000);
  private readonly bookedByUs = new Map<string, BookingResult>();

  constructor(private readonly o: LtmsOptions) {}

  /** DEBUG_ECHO: checks transport, framing and auth. Bypasses fault injection, so it says nothing about load ops. */
  async ping(msg = 'HELLO', extra: Record<string, string> = {}): Promise<{ fieldsParsed: number; msg: string }> {
    const out = await this.once('DEBUG_ECHO', { MSG: msg, ...extra }, this.o.requestTimeoutMs);
    if (out.kind === 'error') throw this.mapCode(out.code, out.message);
    const rec = out.records[0];
    if (out.records.length !== 1 || !rec) throw new MalformedResponseError('echo must return exactly one record');
    return { fieldsParsed: int(rec, 'FIELDS_PARSED'), msg: rec.MSG ?? '' };
  }

  async searchLoads(q: LoadSearchQuery): Promise<LoadSummary[]> {
    const fields = {
      ORIG_CITY: q.originCity,
      ORIG_STATE: q.originState?.toUpperCase(),
      DEST_CITY: q.destinationCity,
      DEST_STATE: q.destinationState?.toUpperCase(),
      EQTYPE: q.equipmentType?.toUpperCase(),
      MAX_RESULTS: q.maxResults ?? this.o.maxResults,
    };
    const out = await this.read('LOAD_QUERY', fields);
    if (out.kind === 'error') throw this.mapCode(out.code, out.message);
    return out.records.map(toSummary);
  }

  async getLoad(loadId: string): Promise<Load | null> {
    const out = await this.read('LOAD_GET', { LOAD_ID: loadId });
    if (out.kind === 'error') {
      if (out.code === 'UNKNOWN_LOAD') return null;
      throw this.mapCode(out.code, out.message);
    }
    if (out.records.length !== 1) throw new TmsError('malformed', `LOAD_GET returned ${out.records.length} records`);
    return toLoad(out.records[0]!);
  }

  /**
   * LOAD_BOOK is not idempotent and its response can be lost. If an attempt is ambiguous (timeout, partial,
   * malformed) and the retry answers ALREADY_BOOKED, the booking view is per token, so that means *we* booked it.
   */
  async bookLoad(loadId: string, mcNumber: string, rate: number): Promise<BookingResult> {
    if (!/^\d{1,8}$/.test(mcNumber)) throw new TmsError('client_bug', 'MC number must be numeric');
    if (!Number.isInteger(rate) || rate <= 0) throw new TmsError('rate_rejected', 'rate must be a positive integer');
    const cached = this.bookedByUs.get(loadId);
    if (cached) return cached;

    const started = Date.now();
    let ambiguous = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.o.retries; attempt++) {
      const remaining = this.o.budgetMs - (Date.now() - started);
      if (remaining <= 200) break;
      try {
        const out = await this.breaker.exec(() => this.once('LOAD_BOOK', { LOAD_ID: loadId, MC_NUM: mcNumber, AGREED_RATE: rate }, Math.min(this.o.requestTimeoutMs, remaining)));
        if (out.kind === 'ok') {
          const rec = out.records[0];
          if (out.records.length !== 1 || !rec) throw new MalformedResponseError(`LOAD_BOOK returned ${out.records.length} records`);
          const result: BookingResult = { loadId, status: 'BOOKED', bookingRef: pattern(rec, 'BOOKING_REF', /^[A-Z0-9]{1,16}$/) };
          await this.journal({ loadId, mcNumber, rate, attempt, result: 'BOOKED', bookingRef: result.bookingRef });
          this.bookedByUs.set(loadId, result);
          return result;
        }
        if (out.code === 'ALREADY_BOOKED' && ambiguous) {
          const result: BookingResult = { loadId, status: 'BOOKED_UNCONFIRMED', bookingRef: null };
          await this.journal({ loadId, mcNumber, rate, attempt, result: 'BOOKED_UNCONFIRMED' });
          this.bookedByUs.set(loadId, result);
          return result;
        }
        if (out.code === 'SERVER_ERROR') {
          ambiguous = true; // the server may have committed before failing
          lastErr = this.mapCode(out.code, out.message);
        } else {
          await this.journal({ loadId, mcNumber, rate, attempt, result: out.code });
          throw this.mapCode(out.code, out.message);
        }
      } catch (err) {
        if (err instanceof TmsError) throw err;
        if (err instanceof ProtocolEncodeError) throw new TmsError('client_bug', err.message);
        if (err instanceof CircuitOpenError) { lastErr = err; break; }
        if (!isFault(err)) throw err;
        ambiguous = true;
        lastErr = err;
        this.o.logger?.warn({ cmd: 'LOAD_BOOK', loadId, attempt, fault: (err as Error).name }, 'ltms fault');
      }
      await sleep(Math.min(100 * 2 ** attempt * Math.random() + 50, 1000));
    }
    await this.journal({ loadId, mcNumber, rate, result: ambiguous ? 'UNKNOWN' : 'FAILED', error: String(lastErr) });
    if (ambiguous) throw new TmsError('booking_unknown', `booking outcome unknown: ${String(lastErr)}`);
    throw this.toTmsError(lastErr);
  }

  // ---- internals ----

  /** Idempotent reads: retry faults with backoff inside the time budget. */
  private async read(cmd: Command, fields: Record<string, string | number | undefined>): Promise<Outcome> {
    const started = Date.now();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.o.retries; attempt++) {
      const remaining = this.o.budgetMs - (Date.now() - started);
      if (remaining <= 200) break;
      try {
        const out = await this.breaker.exec(() => this.once(cmd, fields, Math.min(this.o.requestTimeoutMs, remaining)));
        if (out.kind === 'error' && out.code === 'SERVER_ERROR') {
          lastErr = this.mapCode(out.code, out.message);
        } else {
          return out;
        }
      } catch (err) {
        if (err instanceof CircuitOpenError) throw new TmsError('unavailable', err.message);
        if (err instanceof ProtocolEncodeError) throw new TmsError('client_bug', err.message);
        if (!isFault(err)) throw err;
        lastErr = err;
        this.o.logger?.warn({ cmd, attempt, fault: (err as Error).name, msg: (err as Error).message }, 'ltms fault');
      }
      await sleep(Math.min(100 * 2 ** attempt * Math.random() + 50, 1000));
    }
    throw this.toTmsError(lastErr);
  }

  private async once(cmd: Command, fields: Record<string, string | number | undefined>, timeoutMs: number): Promise<Outcome> {
    const line = encodeRequest(cmd, this.o.token, fields);
    const t0 = Date.now();
    const lines = await sendRequest(line, { host: this.o.host, port: this.o.port, connectTimeoutMs: this.o.connectTimeoutMs, requestTimeoutMs: timeoutMs });
    const out = parseResponse(lines);
    this.o.logger?.info({ cmd, req: redact(line.trimEnd()), ms: Date.now() - t0, records: out.kind === 'ok' ? out.records.length : 0, code: out.kind === 'error' ? out.code : undefined }, 'ltms request');
    return out;
  }

  private mapCode(code: string, message: string): TmsError {
    switch (code) {
      case 'AUTH_FAILED':
        this.o.logger?.error({ code }, 'LTMS token rejected: check TMS_TOKEN');
        return new TmsError('auth', message, code);
      case 'UNKNOWN_LOAD': return new TmsError('not_found', message, code);
      case 'ALREADY_BOOKED': return new TmsError('not_available', message, code);
      case 'INVALID_RATE': return new TmsError('rate_rejected', message, code);
      case 'SERVER_ERROR': return new TmsError('unavailable', message, code);
      case 'MISSING_FIELD':
      case 'MALFORMED':
      case 'UNKNOWN_CMD': return new TmsError('client_bug', message, code);
      default: return new TmsError('unavailable', `unknown TMS error ${code}: ${message}`, code);
    }
  }

  private toTmsError(err: unknown): TmsError {
    if (err instanceof TmsError) return err;
    if (err instanceof TmsTimeoutError) return new TmsError('timeout', err.message);
    if (err instanceof PartialResponseError || err instanceof FramingError || err instanceof MalformedResponseError) return new TmsError('malformed', err.message);
    return new TmsError('unavailable', err instanceof Error ? err.message : 'TMS unavailable');
  }

  private async journal(entry: Record<string, unknown>) {
    this.o.logger?.info({ booking: entry }, 'ltms booking attempt');
    if (!this.o.bookingJournalPath) return;
    try {
      await appendFile(this.o.bookingJournalPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    } catch (err) {
      this.o.logger?.error({ err: String(err) }, 'could not write booking journal');
    }
  }
}

// Manual shows LD + 10 digits; the real server sends shorter ids padded with spaces ("LD00925     ").
const LOAD_ID_RE = /^[A-Z]{2}\d{1,10}$/;
const STATE_RE = /^[A-Z]{2}$/;
const ZIP_RE = /^\d{5}$/;

export function toSummary(rec: TmsRecord): LoadSummary {
  return {
    loadId: pattern(rec, 'LOAD_ID', LOAD_ID_RE),
    origin: `${text(rec, 'ORIG_CITY')}, ${pattern(rec, 'ORIG_STATE', STATE_RE)}`,
    originZip: pattern(rec, 'ORIG_ZIP', ZIP_RE),
    destination: `${text(rec, 'DEST_CITY')}, ${pattern(rec, 'DEST_STATE', STATE_RE)}`,
    destinationZip: pattern(rec, 'DEST_ZIP', ZIP_RE),
    pickupDatetime: datetime(rec, 'PICKUP_DT'),
    equipmentType: pattern(rec, 'EQTYPE', /^[A-Z_]+$/),
    loadboardRate: int(rec, 'RATE'),
    miles: int(rec, 'MILES'),
    status: pattern(rec, 'STATUS', /^[A-Z_]+$/),
  };
}

export function toLoad(rec: TmsRecord): Load {
  return {
    ...toSummary(rec),
    deliveryDatetime: datetime(rec, 'DELIVERY_DT'),
    weight: int(rec, 'WEIGHT'),
    commodityType: text(rec, 'COMMODITY'),
    numOfPieces: int(rec, 'PIECES'),
    dimensions: text(rec, 'DIMS'),
    notes: optionalText(rec, 'NOTES'),
    maxRate: optionalInt(rec, 'MAX_BUY'),
  };
}
