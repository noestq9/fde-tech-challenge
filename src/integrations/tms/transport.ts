import { Socket } from 'node:net';
import { MAX_FRAME_BYTES } from './protocol.js';

// One TCP connection per request (the server closes after each response, reuse is unsupported).
// We stop reading as soon as we see END or an ERR line instead of waiting for the server to close,
// because "delayed termination" faults keep the socket open after a complete response.

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}
export class TmsTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmsTimeoutError';
  }
}
export class PartialResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartialResponseError';
  }
}
export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FramingError';
  }
}

export interface TransportOptions {
  host: string;
  port: number;
  connectTimeoutMs: number;
  /** Hard deadline for the whole request: connect + write + read. */
  requestTimeoutMs: number;
  maxResponseBytes?: number;
}

export function sendRequest(line: string, opts: TransportOptions): Promise<string[]> {
  const maxBytes = opts.maxResponseBytes ?? 64 * MAX_FRAME_BYTES;

  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const lines: string[] = [];
    let buf = '';
    let received = 0;
    let settled = false;

    const finish = (err: Error | null, value?: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(connectTimer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value!);
    };

    const deadline = setTimeout(() => finish(new TmsTimeoutError(`no complete response within ${opts.requestTimeoutMs}ms`)), opts.requestTimeoutMs);
    const connectTimer = setTimeout(() => finish(new TmsTimeoutError(`connect timeout after ${opts.connectTimeoutMs}ms`)), opts.connectTimeoutMs);

    socket.on('connect', () => {
      clearTimeout(connectTimer);
      socket.write(line, 'ascii');
    });

    socket.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) return finish(new FramingError('response exceeds size limit'));
      for (const byte of chunk) if (byte > 0x7e || (byte < 0x20 && byte !== 0x0d && byte !== 0x0a)) return finish(new FramingError('non-ASCII byte in response'));
      buf += chunk.toString('ascii');

      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!raw.endsWith('\r')) return finish(new FramingError('line terminated by \\n without \\r'));
        const l = raw.slice(0, -1);
        if (l.length + 2 > MAX_FRAME_BYTES) return finish(new FramingError('line exceeds 4096 bytes'));
        lines.push(l);
        if (l === 'END' || l.startsWith('ERR|')) return finish(null, lines);
      }
      if (buf.length + 2 > MAX_FRAME_BYTES) return finish(new FramingError('unterminated line exceeds 4096 bytes'));
    });

    socket.on('end', () => finish(new PartialResponseError(`connection closed before END (${lines.length} complete lines)`)));
    socket.on('close', () => finish(new PartialResponseError('connection closed before END')));
    socket.on('error', (err) => finish(new TransportError(err.message)));

    socket.connect({ host: opts.host, port: opts.port });
  });
}
