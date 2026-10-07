// Diagnostic dump: sends a few raw requests to the real TMS and records exactly what came back
// (token redacted), plus why our parser accepted or rejected each response.
//   npm run tms:dump   -> prints a summary and writes reports/tms-dump.txt (safe to share: no token inside)

import { mkdirSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { encodeRequest, parseResponse, redact } from '../integrations/tms/protocol.js';
import { toLoad, toSummary } from '../integrations/tms/ltmsClient.js';
import { loadDotEnv, need } from './env.js';

loadDotEnv();
const host = need('TMS_HOST');
const port = Number(need('TMS_PORT'));
const token = need('TMS_TOKEN');
const out: string[] = [];
const log = (s = '') => {
  out.push(s.split(token).join('***'));
  console.log(s.split(token).join('***'));
};

/** Reads raw bytes until the server closes or 6 s pass. No framing logic: we want to see the wire as is. */
function rawExchange(line: string): Promise<{ bytes: Buffer; closedBy: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks: Buffer[] = [];
    const sock = new Socket();
    const done = (closedBy: string) => {
      clearTimeout(timer);
      sock.destroy();
      resolve({ bytes: Buffer.concat(chunks), closedBy, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => done('client timeout 6s'), 6000);
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('end', () => done('server closed'));
    sock.on('error', (e) => done(`error ${e.message}`));
    sock.connect({ host, port }, () => sock.write(line, 'ascii'));
  });
}

function show(bytes: Buffer) {
  // JSON-escape so CR, LF, tabs and odd bytes are visible.
  const text = bytes.toString('latin1');
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    if (i === lines.length - 1 && l === '') return;
    log(`    [${i}] len=${l.length} ${JSON.stringify(l.length > 600 ? `${l.slice(0, 600)}…` : l)}`);
  });
  const nonAscii = [...bytes].filter((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d));
  if (nonAscii.length) log(`    non-ASCII/control bytes: ${[...new Set(nonAscii)].map((b) => `0x${b.toString(16)}`).join(' ')}`);
}

function tryParse(bytes: Buffer, kind: 'summary' | 'detail' | 'echo') {
  const text = bytes.toString('latin1');
  const lines = text.split('\r\n');
  if (lines.at(-1) === '') lines.pop();
  // Cut at END / ERR like the transport does.
  const endIdx = lines.findIndex((l) => l === 'END' || l.startsWith('ERR|'));
  const framed = endIdx === -1 ? lines : lines.slice(0, endIdx + 1);
  try {
    const parsed = parseResponse(framed);
    if (parsed.kind === 'error') return `ERR ${parsed.code}: ${parsed.message}`;
    for (const r of parsed.records) {
      if (kind === 'summary') toSummary(r);
      if (kind === 'detail') toLoad(r);
    }
    return `OK ${parsed.records.length} record(s)${endIdx === -1 ? ' (no END seen)' : ''}`;
  } catch (err) {
    return `REJECTED ${(err as Error).name}: ${(err as Error).message}`;
  }
}

async function probe(label: string, cmd: 'LOAD_QUERY' | 'LOAD_GET' | 'DEBUG_ECHO', fields: Record<string, string | number>, kind: 'summary' | 'detail' | 'echo', tries = 3) {
  const line = encodeRequest(cmd, token, fields);
  log(`\n## ${label}\n> ${redact(line.trimEnd())}`);
  let firstId: string | undefined;
  for (let i = 0; i < tries; i++) {
    const r = await rawExchange(line);
    log(`  try ${i + 1}: ${r.bytes.length} bytes, ${r.ms}ms, ${r.closedBy}`);
    show(r.bytes);
    log(`  parser: ${tryParse(r.bytes, kind)}`);
    firstId ??= r.bytes.toString('latin1').match(/LOAD_ID:([^|\r\n]+)/)?.[1]?.trim();
  }
  return firstId;
}

async function main() {
  log(`LTMS raw dump ${new Date().toISOString()} host=${host}:${port}`);
  await probe('DEBUG_ECHO', 'DEBUG_ECHO', { MSG: 'HELLO' }, 'echo', 1);

  let id: string | undefined;
  for (const [label, f] of [
    ['query by state TX', { ORIG_STATE: 'TX', MAX_RESULTS: 3 }],
    ['query by state CA', { ORIG_STATE: 'CA', MAX_RESULTS: 3 }],
    ['query by state IL', { ORIG_STATE: 'IL', MAX_RESULTS: 3 }],
    ['query by equipment DRY_VAN', { EQTYPE: 'DRY_VAN', MAX_RESULTS: 3 }],
    ['query by equipment REEFER', { EQTYPE: 'REEFER', MAX_RESULTS: 3 }],
    ['query by city Chicago', { ORIG_CITY: 'Chicago', MAX_RESULTS: 3 }],
  ] as Array<[string, Record<string, string | number>]>) {
    id ??= await probe(label, 'LOAD_QUERY', f, 'summary');
  }
  if (id) await probe(`detail ${id}`, 'LOAD_GET', { LOAD_ID: id }, 'detail');
  else log('\nNo LOAD_ID seen in any query, skipped LOAD_GET.');

  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/tms-dump.txt', `${out.join('\n')}\n`);
  console.log('\nWrote reports/tms-dump.txt (token redacted). Upload it to the thread.');
}

main();
