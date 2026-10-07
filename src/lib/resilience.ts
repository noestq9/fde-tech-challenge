// Small resilience helpers shared by the external integrations (FMCSA, TMS, OTP webhook).

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withTimeout<T>(what: string, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new TimeoutError(what, ms));
    }, ms);
  });
  try {
    return await Promise.race([fn(ctrl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  /** Return false for errors that should not be retried (e.g. "not found", bad auth). */
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number) => void;
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 200;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = opts.isRetryable ? opts.isRetryable(err) : true;
      if (!retryable || attempt >= opts.retries) throw err;
      opts.onRetry?.(err, attempt + 1);
      // Exponential backoff with full jitter.
      await sleep(Math.random() * base * 2 ** attempt);
    }
  }
}

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`${name} circuit is open`);
    this.name = 'CircuitOpenError';
  }
}

/** After `threshold` consecutive failures, fail fast for `cooldownMs` instead of hammering a sick dependency. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly name: string,
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): 'closed' | 'open' | 'half_open' {
    if (this.failures < this.threshold) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs ? 'half_open' : 'open';
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') throw new CircuitOpenError(this.name);
    try {
      const out = await fn();
      this.failures = 0;
      return out;
    } catch (err) {
      this.failures += 1;
      if (this.failures >= this.threshold) this.openedAt = this.now();
      throw err;
    }
  }
}
