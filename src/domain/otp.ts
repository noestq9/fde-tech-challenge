import { createHmac, randomInt, timingSafeEqual, randomBytes } from 'node:crypto';

// One-time codes are generated and checked only here. The code itself never reaches the LLM:
// it goes straight from this service to the delivery channel, and the agent only learns "sent" / "verified".

export interface OtpDelivery {
  send(to: { channel: 'sms' | 'email'; address: string }, code: string, ctx: { callId: string; mcNumber: string }): Promise<void>;
}

export interface OtpOptions {
  ttlSeconds: number;
  maxAttempts: number;
  maxSends: number;
  /** Demo only: use this code instead of a random one (OTP_DELIVERY=simulated). */
  fixedCode?: string;
  now?: () => number;
}

interface Entry {
  hash: Buffer;
  expiresAt: number;
  attempts: number;
  sends: number;
  verified: boolean;
  locked: boolean;
}

export type SendResult = { sent: true; expiresInSeconds: number } | { sent: false; reason: 'locked' | 'resend_limit' };
export type VerifyResult =
  | { verified: true }
  | { verified: false; reason: 'no_code' | 'expired' | 'mismatch' | 'locked'; attemptsLeft: number };

export class OtpService {
  private entries = new Map<string, Entry>();
  private readonly pepper = randomBytes(32);
  private readonly now: () => number;

  constructor(private readonly delivery: OtpDelivery, private readonly opts: OtpOptions) {
    this.now = opts.now ?? Date.now;
  }

  async send(callId: string, mcNumber: string, to: { channel: 'sms' | 'email'; address: string }): Promise<SendResult> {
    const prev = this.entries.get(callId);
    if (prev?.locked) return { sent: false, reason: 'locked' };
    if (prev && prev.sends >= this.opts.maxSends) return { sent: false, reason: 'resend_limit' };

    const code = this.opts.fixedCode ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
    this.entries.set(callId, {
      hash: this.hash(callId, code),
      expiresAt: this.now() + this.opts.ttlSeconds * 1000,
      // Attempts carry over across resends so "send me another one" can't reset the counter.
      attempts: prev?.attempts ?? 0,
      sends: (prev?.sends ?? 0) + 1,
      verified: false,
      locked: false,
    });
    await this.delivery.send(to, code, { callId, mcNumber });
    return { sent: true, expiresInSeconds: this.opts.ttlSeconds };
  }

  verify(callId: string, code: string): VerifyResult {
    const e = this.entries.get(callId);
    if (!e) return { verified: false, reason: 'no_code', attemptsLeft: 0 };
    if (e.verified) return { verified: true };
    if (e.locked) return { verified: false, reason: 'locked', attemptsLeft: 0 };
    if (this.now() > e.expiresAt) return { verified: false, reason: 'expired', attemptsLeft: this.opts.maxAttempts - e.attempts };

    e.attempts += 1;
    const candidate = this.hash(callId, String(code).replace(/\D/g, ''));
    if (timingSafeEqual(candidate, e.hash)) {
      e.verified = true;
      return { verified: true };
    }
    const attemptsLeft = Math.max(this.opts.maxAttempts - e.attempts, 0);
    if (attemptsLeft === 0) e.locked = true;
    return { verified: false, reason: attemptsLeft === 0 ? 'locked' : 'mismatch', attemptsLeft };
  }

  isVerified(callId: string): boolean {
    return this.entries.get(callId)?.verified === true;
  }

  stats(callId: string) {
    const e = this.entries.get(callId);
    return e ? { attempts: e.attempts, sends: e.sends, verified: e.verified, locked: e.locked } : undefined;
  }

  private hash(callId: string, code: string): Buffer {
    return createHmac('sha256', this.pepper).update(`${callId}:${code}`).digest();
  }
}

export function maskAddress(channel: 'sms' | 'email', address: string): string {
  if (channel === 'sms') return `***-***-${address.replace(/\D/g, '').slice(-4)}`;
  const [user, domain] = address.split('@');
  return `${user?.[0] ?? ''}***@${domain ?? ''}`;
}
