import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MalformedResponseError, ProtocolEncodeError, encodeRequest, parseResponse, redact } from '../src/integrations/tms/protocol.js';
import { toLoad, toSummary } from '../src/integrations/tms/ltmsClient.js';

// Golden tests: the response lines are read verbatim from the spec transcripts, padding included.
const spec = readFileSync(new URL('../docs/LEGACY_TMS_PROTOCOL_SPEC.md', import.meta.url), 'utf8');
const wire = spec.split('\n').filter((l) => l.startsWith('< ')).map((l) => l.slice(2).replace(/\r$/, ''));
const records = wire.filter((l) => l.startsWith('LOAD_ID:'));
const details = records.filter((l) => l.includes('DELIVERY_DT:'));
const summaries = records.filter((l) => !l.includes('DELIVERY_DT:') && !l.includes('BOOKING_REF:'));

describe('LTMS encoder', () => {
  it('puts CMD and AUTH first and terminates with CRLF', () => {
    expect(encodeRequest('LOAD_GET', 'tok', { LOAD_ID: 'LD0000045821' })).toBe('CMD:LOAD_GET|AUTH:tok|LOAD_ID:LD0000045821\r\n');
  });
  it('rejects pipes, CR/LF and non-ASCII in values', () => {
    expect(() => encodeRequest('LOAD_QUERY', 't', { ORIG_CITY: 'A|B' })).toThrow(ProtocolEncodeError);
    expect(() => encodeRequest('LOAD_QUERY', 't', { ORIG_CITY: 'A\r\nCMD:LOAD_BOOK' })).toThrow(ProtocolEncodeError);
    expect(() => encodeRequest('LOAD_QUERY', 't', { ORIG_CITY: 'São Paulo' })).toThrow(ProtocolEncodeError);
  });
  it('rejects fields the server would silently ignore', () => {
    expect(() => encodeRequest('LOAD_GET', 't', { LOADID: 'x' })).toThrow(/not valid/);
  });
  it('rejects frames over 4096 bytes', () => {
    expect(() => encodeRequest('DEBUG_ECHO', 't', { MSG: 'x'.repeat(5000) })).toThrow(/4096/);
  });
  it('redacts the token', () => {
    expect(redact('CMD:LOAD_GET|AUTH:t-9c3a-secret|LOAD_ID:1')).toBe('CMD:LOAD_GET|AUTH:***|LOAD_ID:1');
  });
});

describe('LTMS parser (spec transcripts)', () => {
  it('found the transcripts in the spec', () => {
    expect(summaries.length).toBeGreaterThanOrEqual(4);
    expect(details.length).toBe(3);
  });

  it('parses every LOAD_QUERY transcript record', () => {
    for (const line of summaries) {
      const out = parseResponse([line, 'END']);
      expect(out.kind).toBe('ok');
      if (out.kind === 'ok') expect(() => toSummary(out.records[0]!)).not.toThrow();
    }
  });

  it('parses LOAD_GET details with padding, leading-zero zips, blank notes and MAX_BUY', () => {
    const loads = details.map((l) => {
      const out = parseResponse([l, 'END']);
      if (out.kind !== 'ok') throw new Error('expected ok');
      return toLoad(out.records[0]!);
    });
    const byId = Object.fromEntries(loads.map((l) => [l.loadId, l]));
    expect(byId.LD0000045821).toMatchObject({ origin: 'Atlanta, GA', loadboardRate: 2150, maxRate: 1950, weight: 42000, status: 'OPEN', pickupDatetime: '2026-05-12T08:00:00' });
    expect(byId.LD0000046112).toMatchObject({ destinationZip: '07102', notes: expect.stringContaining('$75/h') });
    expect(byId.LD0000045903!.notes).toBeNull();
  });

  it('treats a missing MAX_BUY as null, not as an error', () => {
    const line = details[0]!.replace(/\|MAX_BUY:\d+$/, '');
    const out = parseResponse([line, 'END']);
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(toLoad(out.records[0]!).maxRate).toBeNull();
  });

  it('parses error lines and empty results', () => {
    expect(parseResponse(['ERR|CODE:UNKNOWN_LOAD|MSG:load not found'])).toEqual({ kind: 'error', code: 'UNKNOWN_LOAD', message: 'load not found' });
    expect(parseResponse(['END'])).toEqual({ kind: 'ok', records: [] });
  });

  it('parses DEBUG_ECHO with its bare ECHO token', () => {
    const out = parseResponse(['ECHO|AUTH:OK|FIELDS_PARSED:3|MSG:HELLO', 'END']);
    expect(out).toMatchObject({ kind: 'ok', records: [{ FIELDS_PARSED: '3', MSG: 'HELLO' }] });
  });

  it('rejects malformed records', () => {
    const good = summaries[0]!;
    expect(() => parseResponse([good])).toThrow(MalformedResponseError); // no END
    expect(() => parseResponse([good.replace('|', '||'), 'END'])).toThrow(MalformedResponseError); // extra delimiter
    expect(() => parseResponse([good.replace('RATE:0002150', 'RATE:000215099'), 'END'])).toThrow(/width/); // too wide
    expect(() => parseResponse([`${good}|RATE:0000001`, 'END'])).toThrow(/duplicate/);
  });

  it('rejects records whose values do not match their type', () => {
    const out = parseResponse([summaries[0]!.replace('RATE:0002150', 'RATE:00021X0'), 'END']);
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(() => toSummary(out.records[0]!)).toThrow(/integer/);
  });
});

describe('LTMS parser (real server wire, captured with tms:dump)', () => {
  const real = readFileSync(new URL('./fixtures/real-wire-records.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);

  it('parses space-padded numbers, short ids and the real widths', () => {
    expect(real.length).toBeGreaterThanOrEqual(4);
    for (const line of real) {
      const out = parseResponse([line, 'END']);
      if (out.kind !== 'ok') throw new Error('expected ok');
      const rec = out.records[0]!;
      const l = 'DELIVERY_DT' in rec ? toLoad(rec) : toSummary(rec);
      expect(l.loadId).toMatch(/^LD\d+$/);
      expect(Number.isInteger(l.loadboardRate)).toBe(true);
    }
  });

  it('reads the real detail record', () => {
    const line = real.find((l) => l.includes('DELIVERY_DT:'))!;
    const out = parseResponse([line, 'END']);
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(toLoad(out.records[0]!)).toMatchObject({ loadId: 'LD00925', loadboardRate: 1277, maxRate: 1552, weight: 20692, numOfPieces: 8, notes: null, status: 'OPEN', dimensions: '45ft x 8ft x 9ft' });
  });

  it('still catches a value that overflows its column', () => {
    expect(() => parseResponse([real[0]!.replace(/RATE:(\d+) +/, 'RATE:$1123456789'), 'END'])).toThrow(/width/);
  });
});
