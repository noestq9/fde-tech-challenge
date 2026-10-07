import type { FastifyBaseLogger } from 'fastify';
import type { OtpDelivery } from '../domain/otp.js';
import { retry, withTimeout } from '../lib/resilience.js';

/** Dev only: writes the code to the server log so you can complete a web call without SMS. */
export class ConsoleOtpDelivery implements OtpDelivery {
  constructor(private readonly log: FastifyBaseLogger) {}
  async send(to: { channel: 'sms' | 'email'; address: string }, code: string, ctx: { callId: string }) {
    this.log.warn({ callId: ctx.callId, channel: to.channel }, `[DEV OTP] code=${code} (never enable console delivery in production)`);
  }
}

/**
 * Posts the code to a separate HappyRobot workflow (Webhook (API) trigger -> Send SMS / email node).
 * Keeps delivery on the platform while the code never passes through the voice agent's run.
 * The trigger authenticates with a HappyRobot API key, sent as a Bearer token.
 */
export class WebhookOtpDelivery implements OtpDelivery {
  constructor(private readonly url: string, private readonly secret: string, private readonly timeoutMs = 5000) {}

  async send(to: { channel: 'sms' | 'email'; address: string }, code: string, ctx: { callId: string; mcNumber: string }) {
    await retry(
      () =>
        withTimeout('otp webhook', this.timeoutMs, async (signal) => {
          const res = await fetch(this.url, {
            method: 'POST',
            signal,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
            body: JSON.stringify({ channel: to.channel, to: to.address, code, call_id: ctx.callId, mc_number: ctx.mcNumber }),
          });
          if (!res.ok) throw new Error(`otp webhook returned ${res.status}`);
        }),
      { retries: 2 },
    );
  }
}
