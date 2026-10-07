import { createServer, type Socket } from 'node:net';

// Local stand-in for the legacy TMS, speaking the same wire protocol and injecting the same silent faults
// (timeout, partial response, malformed response, delayed termination). Used by tests and for demos
// when the real server is unreachable. Not a reference implementation: the real wire is authoritative.

export interface FakeTmsOptions {
  token: string;
  /** Probability (0..1) that an operational command gets a fault. DEBUG_ECHO is never faulted. */
  faultRate: number;
  /** Restrict faults to these kinds. */
  faults: FaultKind[];
  exposeMaxBuy: boolean;
  /** How long a "timeout" fault keeps the socket silent before closing (the real server uses 30 s). */
  idleTimeoutMs: number;
  /** Deterministic fault selection for tests: called instead of Math.random. */
  random?: () => number;
  /** Force the next N operational requests to use this fault (tests). */
  forced?: FaultKind[];
}

export type FaultKind = 'timeout' | 'partial' | 'malformed' | 'delayed';

interface FakeLoad {
  LOAD_ID: string; ORIG_CITY: string; ORIG_STATE: string; ORIG_ZIP: string; DEST_CITY: string; DEST_STATE: string; DEST_ZIP: string;
  PICKUP_DT: string; DELIVERY_DT: string; EQTYPE: string; RATE: number; WEIGHT: number; COMMODITY: string; PIECES: number;
  MILES: number; DIMS: string; NOTES: string; MAX_BUY: number;
}

// The first rows reproduce the spec transcripts verbatim; the rest add lanes out of Chicago and a flatbed.
export const SEED: FakeLoad[] = [
  { LOAD_ID: 'LD0000045821', ORIG_CITY: 'Atlanta', ORIG_STATE: 'GA', ORIG_ZIP: '30303', DEST_CITY: 'Dallas', DEST_STATE: 'TX', DEST_ZIP: '75201', PICKUP_DT: '20261112080000', DELIVERY_DT: '20261113170000', EQTYPE: 'DRY_VAN', RATE: 2150, WEIGHT: 42000, COMMODITY: 'PALLETIZED CONSUMER GOODS', PIECES: 26, MILES: 785, DIMS: '48X40 STD GMA PALLETS', NOTES: 'Drop trailer at destination. Appt required.', MAX_BUY: 1950 },
  { LOAD_ID: 'LD0000045903', ORIG_CITY: 'Atlanta', ORIG_STATE: 'GA', ORIG_ZIP: '30303', DEST_CITY: 'Houston', DEST_STATE: 'TX', DEST_ZIP: '77002', PICKUP_DT: '20261113140000', DELIVERY_DT: '20261114230000', EQTYPE: 'DRY_VAN', RATE: 2280, WEIGHT: 40800, COMMODITY: 'RETAIL DRY GOODS', PIECES: 31, MILES: 789, DIMS: '48X40 STD GMA PALLETS', NOTES: '', MAX_BUY: 2065 },
  { LOAD_ID: 'LD0000046112', ORIG_CITY: 'Miami', ORIG_STATE: 'FL', ORIG_ZIP: '33101', DEST_CITY: 'Newark', DEST_STATE: 'NJ', DEST_ZIP: '07102', PICKUP_DT: '20261114063000', DELIVERY_DT: '20261116120000', EQTYPE: 'REEFER', RATE: 3420, WEIGHT: 38500, COMMODITY: 'FRESH PRODUCE - MIXED', PIECES: 22, MILES: 1280, DIMS: '48X40 CHEP PALLETS', NOTES: 'Reefer set 34F continuous. Pre-cool trailer. Live unload. 2H detention free, then $75/h.', MAX_BUY: 3080 },
  { LOAD_ID: 'LD0000046188', ORIG_CITY: 'Miami Gardens', ORIG_STATE: 'FL', ORIG_ZIP: '33056', DEST_CITY: 'Charlotte', DEST_STATE: 'NC', DEST_ZIP: '28202', PICKUP_DT: '20261115110000', DELIVERY_DT: '20261116090000', EQTYPE: 'REEFER', RATE: 1980, WEIGHT: 36000, COMMODITY: 'FROZEN SEAFOOD', PIECES: 20, MILES: 711, DIMS: '48X40 CHEP PALLETS', NOTES: 'Reefer set -10F.', MAX_BUY: 1790 },
  { LOAD_ID: 'LD0000047001', ORIG_CITY: 'Chicago', ORIG_STATE: 'IL', ORIG_ZIP: '60607', DEST_CITY: 'Dallas', DEST_STATE: 'TX', DEST_ZIP: '75201', PICKUP_DT: '20261112090000', DELIVERY_DT: '20261113180000', EQTYPE: 'DRY_VAN', RATE: 2600, WEIGHT: 38000, COMMODITY: 'PACKAGED FOODS', PIECES: 22, MILES: 967, DIMS: '48X40 STD GMA PALLETS', NOTES: 'Lumper paid by shipper.', MAX_BUY: 2340 },
  { LOAD_ID: 'LD0000047002', ORIG_CITY: 'Chicago', ORIG_STATE: 'IL', ORIG_ZIP: '60638', DEST_CITY: 'Atlanta', DEST_STATE: 'GA', DEST_ZIP: '30303', PICKUP_DT: '20261112100000', DELIVERY_DT: '20261113160000', EQTYPE: 'REEFER', RATE: 2450, WEIGHT: 41000, COMMODITY: 'FROZEN POULTRY', PIECES: 24, MILES: 716, DIMS: '48X40 CHEP PALLETS', NOTES: 'Reefer set 0F continuous.', MAX_BUY: 2200 },
  { LOAD_ID: 'LD0000047003', ORIG_CITY: 'Gary', ORIG_STATE: 'IN', ORIG_ZIP: '46402', DEST_CITY: 'Denver', DEST_STATE: 'CO', DEST_ZIP: '80202', PICKUP_DT: '20261113070000', DELIVERY_DT: '20261115120000', EQTYPE: 'FLATBED', RATE: 3300, WEIGHT: 44000, COMMODITY: 'STEEL COILS', PIECES: 6, MILES: 1015, DIMS: '72X72X60 COILS', NOTES: 'Tarps and chains required.', MAX_BUY: 2970 },
  { LOAD_ID: 'LD0000047004', ORIG_CITY: 'Chicago Heights', ORIG_STATE: 'IL', ORIG_ZIP: '60411', DEST_CITY: 'Columbus', DEST_STATE: 'OH', DEST_ZIP: '43215', PICKUP_DT: '20261112130000', DELIVERY_DT: '20261113090000', EQTYPE: 'DRY_VAN', RATE: 1250, WEIGHT: 22000, COMMODITY: 'PAPER PRODUCTS', PIECES: 18, MILES: 352, DIMS: '48X40 STD GMA PALLETS', NOTES: '', MAX_BUY: 1125 },
];

const padR = (s: string, n: number) => s.padEnd(n, ' ').slice(0, n);
const padL = (v: number, n: number) => String(v).padStart(n, '0');

function summaryLine(l: FakeLoad, status: string) {
  return [
    `LOAD_ID:${l.LOAD_ID}`, `ORIG_CITY:${padR(l.ORIG_CITY, 30)}`, `ORIG_STATE:${l.ORIG_STATE}`, `ORIG_ZIP:${l.ORIG_ZIP}`,
    `DEST_CITY:${padR(l.DEST_CITY, 30)}`, `DEST_STATE:${l.DEST_STATE}`, `DEST_ZIP:${l.DEST_ZIP}`, `PICKUP_DT:${l.PICKUP_DT}`,
    `EQTYPE:${padR(l.EQTYPE, 10)}`, `RATE:${padL(l.RATE, 7)}`, `MILES:${padL(l.MILES, 6)}`, `STATUS:${status}`,
  ].join('|');
}

function detailLine(l: FakeLoad, status: string, exposeMaxBuy: boolean) {
  const parts = [
    `LOAD_ID:${l.LOAD_ID}`, `ORIG_CITY:${padR(l.ORIG_CITY, 30)}`, `ORIG_STATE:${l.ORIG_STATE}`, `ORIG_ZIP:${l.ORIG_ZIP}`,
    `DEST_CITY:${padR(l.DEST_CITY, 30)}`, `DEST_STATE:${l.DEST_STATE}`, `DEST_ZIP:${l.DEST_ZIP}`, `PICKUP_DT:${l.PICKUP_DT}`,
    `DELIVERY_DT:${l.DELIVERY_DT}`, `EQTYPE:${padR(l.EQTYPE, 10)}`, `RATE:${padL(l.RATE, 7)}`, `WEIGHT:${padL(l.WEIGHT, 7)}`,
    `COMMODITY:${padR(l.COMMODITY, 32)}`, `PIECES:${padL(l.PIECES, 6)}`, `MILES:${padL(l.MILES, 6)}`, `DIMS:${padR(l.DIMS, 35)}`,
    `NOTES:${padR(l.NOTES, 114)}`, `STATUS:${padR(status, 8)}`,
  ];
  if (exposeMaxBuy) parts.push(`MAX_BUY:${padL(l.MAX_BUY, 7)}`);
  return parts.join('|');
}

function parseRequest(line: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const part of line.split('|')) {
    const i = part.indexOf(':');
    if (i <= 0) return null;
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

const norm = (s: string) => s.toLowerCase();

export function startFakeTms(port: number, opts: FakeTmsOptions) {
  const booked = new Map<string, Set<string>>(); // token -> load ids
  const rnd = opts.random ?? Math.random;
  const forced = [...(opts.forced ?? [])];
  const counters = { requests: 0, faults: { timeout: 0, partial: 0, malformed: 0, delayed: 0 } as Record<FaultKind, number> };

  const pickFault = (): FaultKind | null => {
    if (forced.length) return forced.shift()!;
    if (!opts.faults.length || rnd() >= opts.faultRate) return null;
    return opts.faults[Math.floor(rnd() * opts.faults.length)]!;
  };

  const respond = (sock: Socket, lines: string[], fault: FaultKind | null) => {
    const payload = lines.map((l) => `${l}\r\n`).join('');
    switch (fault) {
      case 'timeout':
        setTimeout(() => sock.destroy(), opts.idleTimeoutMs);
        return;
      case 'partial': {
        // Valid prefix, cut somewhere before END.
        const cut = Math.max(1, Math.floor(payload.length * (0.2 + rnd() * 0.6)));
        sock.end(payload.slice(0, Math.min(cut, payload.length - 6)));
        return;
      }
      case 'malformed': {
        const variants = [
          payload.replace('|', '||'), // extra delimiter
          payload.replace(/RATE:(\d{7})/, 'RATE:$1999'), // value exceeds width
          payload.replace(/\r\n/, '\n'), // unterminated line
        ];
        sock.end(variants[Math.floor(rnd() * variants.length)]);
        return;
      }
      case 'delayed':
        sock.write(payload);
        setTimeout(() => sock.destroy(), opts.idleTimeoutMs);
        return;
      default:
        sock.end(payload);
    }
  };

  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = '';
    sock.setEncoding('ascii');
    const idle = setTimeout(() => sock.destroy(), opts.idleTimeoutMs);
    sock.on('error', () => undefined);
    sock.on('close', () => clearTimeout(idle));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf('\r\n');
      if (idx === -1) {
        if (buf.length > 4096) sock.end('ERR|CODE:MALFORMED|MSG:frame too large\r\n');
        return;
      }
      clearTimeout(idle);
      counters.requests++;
      const req = parseRequest(buf.slice(0, idx));
      if (!req || !req.CMD) return void sock.end('ERR|CODE:MALFORMED|MSG:malformed request\r\n');
      if (req.AUTH !== opts.token) return void sock.end('ERR|CODE:AUTH_FAILED|MSG:invalid or missing auth token\r\n');
      const mine = booked.get(req.AUTH) ?? new Set<string>();
      booked.set(req.AUTH, mine);
      const statusOf = (id: string) => (mine.has(id) ? 'BOOKED' : 'OPEN');

      if (req.CMD === 'DEBUG_ECHO') {
        return respond(sock, [`ECHO|AUTH:OK|FIELDS_PARSED:${Object.keys(req).length}|MSG:${req.MSG ?? ''}`, 'END'], null);
      }

      const fault = pickFault();
      if (fault) counters.faults[fault]++;

      switch (req.CMD) {
        case 'LOAD_QUERY': {
          const filters = ['ORIG_CITY', 'ORIG_STATE', 'ORIG_ZIP', 'DEST_CITY', 'DEST_STATE', 'DEST_ZIP', 'EQTYPE', 'PICKUP_DT'];
          if (!filters.some((f) => req[f])) return respond(sock, ['ERR|CODE:MISSING_FIELD|MSG:at least one filter required'], fault);
          const max = Math.min(Number(req.MAX_RESULTS) || 10, 10);
          const hits = SEED.filter(
            (l) =>
              statusOf(l.LOAD_ID) === 'OPEN' &&
              (!req.ORIG_CITY || norm(l.ORIG_CITY).startsWith(norm(req.ORIG_CITY))) &&
              (!req.ORIG_STATE || l.ORIG_STATE === req.ORIG_STATE) &&
              (!req.ORIG_ZIP || l.ORIG_ZIP === req.ORIG_ZIP) &&
              (!req.DEST_CITY || norm(l.DEST_CITY).startsWith(norm(req.DEST_CITY))) &&
              (!req.DEST_STATE || l.DEST_STATE === req.DEST_STATE) &&
              (!req.DEST_ZIP || l.DEST_ZIP === req.DEST_ZIP) &&
              (!req.EQTYPE || l.EQTYPE === req.EQTYPE) &&
              (!req.PICKUP_DT || l.PICKUP_DT.startsWith(req.PICKUP_DT)),
          ).slice(0, max);
          return respond(sock, [...hits.map((l) => summaryLine(l, statusOf(l.LOAD_ID))), 'END'], fault);
        }
        case 'LOAD_GET': {
          const l = SEED.find((x) => x.LOAD_ID === req.LOAD_ID);
          if (!l) return respond(sock, ['ERR|CODE:UNKNOWN_LOAD|MSG:load not found'], fault);
          return respond(sock, [detailLine(l, statusOf(l.LOAD_ID), opts.exposeMaxBuy), 'END'], fault);
        }
        case 'LOAD_BOOK': {
          if (!req.LOAD_ID || !req.MC_NUM || !req.AGREED_RATE) return respond(sock, ['ERR|CODE:MISSING_FIELD|MSG:missing required field'], fault);
          const l = SEED.find((x) => x.LOAD_ID === req.LOAD_ID);
          if (!l) return respond(sock, ['ERR|CODE:UNKNOWN_LOAD|MSG:load not found'], fault);
          if (mine.has(l.LOAD_ID)) return respond(sock, ['ERR|CODE:ALREADY_BOOKED|MSG:load not available'], fault);
          const rate = Number(req.AGREED_RATE);
          // The real rule is unpublished; this guess rejects non-positive and absurdly high rates.
          if (!/^\d+$/.test(req.AGREED_RATE) || rate <= 0 || rate > l.RATE * 1.5) return respond(sock, ['ERR|CODE:INVALID_RATE|MSG:rate rejected'], fault);
          // Commit before the (possibly faulted) write, like a real server that loses the response.
          mine.add(l.LOAD_ID);
          const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
          const ref = `BR${padL(Math.floor(rnd() * 1e14), 14)}`;
          return respond(sock, [`LOAD_ID:${l.LOAD_ID}|BOOKING_REF:${ref}|STATUS:BOOKED  |TIMESTAMP:${ts}`, 'END'], fault);
        }
        default:
          return respond(sock, ['ERR|CODE:UNKNOWN_CMD|MSG:unknown command'], null);
      }
    });
  });

  return new Promise<{ port: number; close: () => Promise<void>; counters: typeof counters; force: (f: FaultKind[]) => void }>((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : port,
        counters,
        force: (f) => forced.push(...f),
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}
