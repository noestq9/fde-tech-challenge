// Wire format of the legacy TMS (see docs/LEGACY_TMS_PROTOCOL_SPEC.md).
// Request:  CMD:<cmd>|AUTH:<token>|KEY:VALUE|...\r\n
// Response: zero or more KEY:VALUE|... records, then END\r\n   — or a single ERR|CODE:<c>|MSG:<m>\r\n
// The server injects silent faults (timeouts, truncation, malformed lines), so parsing is strict:
// anything that doesn't match the contract is rejected whole, never partially trusted.

export const MAX_FRAME_BYTES = 4096;

export type Command = 'LOAD_QUERY' | 'LOAD_GET' | 'LOAD_BOOK' | 'DEBUG_ECHO';

/** Allowed request fields per command. The server silently drops unknown fields, so typos must die here. */
const REQUEST_FIELDS: Record<Command, ReadonlySet<string>> = {
  LOAD_QUERY: new Set(['ORIG_CITY', 'ORIG_STATE', 'ORIG_ZIP', 'DEST_CITY', 'DEST_STATE', 'DEST_ZIP', 'EQTYPE', 'PICKUP_DT', 'MAX_RESULTS']),
  LOAD_GET: new Set(['LOAD_ID']),
  LOAD_BOOK: new Set(['LOAD_ID', 'MC_NUM', 'AGREED_RATE']),
  DEBUG_ECHO: new Set(), // free-form: any field is echoed and counted
};

/** Max widths observed in the spec transcripts (§9). Longer values mean a malformed response. */
export const FIELD_WIDTHS: Record<string, number> = {
  LOAD_ID: 12, ORIG_CITY: 30, ORIG_STATE: 2, ORIG_ZIP: 5, DEST_CITY: 30, DEST_STATE: 2, DEST_ZIP: 5,
  PICKUP_DT: 14, DELIVERY_DT: 14, EQTYPE: 10, RATE: 7, WEIGHT: 7, COMMODITY: 32, PIECES: 6, MILES: 6,
  DIMS: 35, NOTES: 114, STATUS: 8, MAX_BUY: 7, BOOKING_REF: 16, TIMESTAMP: 14,
};

export class ProtocolEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolEncodeError';
  }
}

export class MalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedResponseError';
  }
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

export function encodeRequest(cmd: Command, token: string, fields: Record<string, string | number | undefined>): string {
  const parts = [`CMD:${cmd}`, `AUTH:${token}`];
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined || raw === '') continue;
    if (!/^[A-Z_]+$/.test(key)) throw new ProtocolEncodeError(`bad field name ${key}`);
    if (cmd !== 'DEBUG_ECHO' && !REQUEST_FIELDS[cmd].has(key)) throw new ProtocolEncodeError(`field ${key} is not valid for ${cmd}`);
    const value = String(raw);
    if (value.includes('|') || !ASCII_PRINTABLE.test(value)) throw new ProtocolEncodeError(`invalid characters in ${key}`);
    parts.push(`${key}:${value}`);
  }
  if (!ASCII_PRINTABLE.test(token) || token.includes('|')) throw new ProtocolEncodeError('invalid characters in token');
  const line = `${parts.join('|')}\r\n`;
  if (Buffer.byteLength(line, 'ascii') > MAX_FRAME_BYTES) throw new ProtocolEncodeError('request exceeds 4096 bytes');
  return line;
}

/** Never log a token: AUTH:<anything> becomes AUTH:***. */
export function redact(line: string): string {
  return line.replace(/AUTH:[^|\r\n]*/g, 'AUTH:***');
}

export type TmsRecord = Record<string, string>;

export type ParsedResponse = { kind: 'ok'; records: TmsRecord[] } | { kind: 'error'; code: string; message: string };

/**
 * Parses a complete response. `lines` are the lines the transport read, without their \r\n.
 * The transport only hands over a response once it saw END or an ERR line, so a missing terminator
 * here means the transport gave up (partial response).
 */
export function parseResponse(lines: string[]): ParsedResponse {
  if (lines.length === 0) throw new MalformedResponseError('empty response');
  const first = lines[0]!;

  if (first.startsWith('ERR|')) {
    if (lines.length !== 1) throw new MalformedResponseError('error line followed by extra lines');
    const fields = splitFields(first.slice(4));
    if (!fields.CODE) throw new MalformedResponseError('error line without CODE');
    return { kind: 'error', code: fields.CODE, message: fields.MSG ?? '' };
  }

  if (lines.at(-1) !== 'END') throw new MalformedResponseError('response missing END terminator');
  const records = lines.slice(0, -1).map((line, i) => {
    if (line === 'END') throw new MalformedResponseError(`END appeared before the last line (line ${i + 1})`);
    return parseRecord(line);
  });
  return { kind: 'ok', records };
}

function parseRecord(line: string): TmsRecord {
  if (!ASCII_PRINTABLE.test(line)) throw new MalformedResponseError('non-ASCII or control characters in record');
  const rec: TmsRecord = {};
  const parts = line.split('|');
  for (const [i, part] of parts.entries()) {
    const idx = part.indexOf(':');
    if (idx <= 0) {
      // DEBUG_ECHO starts with a bare "ECHO" token; anywhere else a part without KEY: is a framing error.
      if (i === 0 && part === 'ECHO') continue;
      throw new MalformedResponseError(`field without key: "${part.slice(0, 20)}"`);
    }
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new MalformedResponseError(`bad field name "${key.slice(0, 20)}"`);
    if (key in rec) throw new MalformedResponseError(`duplicate field ${key}`);
    const width = FIELD_WIDTHS[key];
    if (width !== undefined && value.length > width) throw new MalformedResponseError(`${key} exceeds width ${width}`);
    rec[key] = value;
  }
  return rec;
}

function splitFields(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split('|')) {
    const idx = part.indexOf(':');
    if (idx > 0) out[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return out;
}

// ---- typed field readers: each throws MalformedResponseError when the value doesn't fit its format ----

export function req(rec: TmsRecord, key: string): string {
  const v = rec[key];
  if (v === undefined) throw new MalformedResponseError(`missing field ${key}`);
  return v;
}

export function text(rec: TmsRecord, key: string): string {
  return req(rec, key).trimEnd();
}

/** Blank padded text (e.g. empty NOTES) is a real value meaning "none", not a missing field. */
export function optionalText(rec: TmsRecord, key: string): string | null {
  const v = req(rec, key).trimEnd();
  return v === '' ? null : v;
}

export function int(rec: TmsRecord, key: string): number {
  const v = req(rec, key).trim();
  if (!/^\d+$/.test(v)) throw new MalformedResponseError(`${key} is not an integer`);
  return Number.parseInt(v, 10);
}

export function optionalInt(rec: TmsRecord, key: string): number | null {
  return rec[key] === undefined ? null : int(rec, key);
}

export function pattern(rec: TmsRecord, key: string, re: RegExp): string {
  const v = req(rec, key).trimEnd();
  if (!re.test(v)) throw new MalformedResponseError(`${key} has an unexpected format`);
  return v;
}

/** YYYYMMDDHHMMSS → ISO string. Timezone is undocumented, so it is kept naive (no offset). */
export function datetime(rec: TmsRecord, key: string): string {
  const v = pattern(rec, key, /^\d{14}$/);
  const iso = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(8, 10)}:${v.slice(10, 12)}:${v.slice(12, 14)}`;
  if (Number.isNaN(Date.parse(iso))) throw new MalformedResponseError(`${key} is not a valid date`);
  return iso;
}
