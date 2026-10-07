import { describe, expect, it } from 'vitest';
import { OtpService, maskAddress, type OtpDelivery } from '../src/domain/otp.js';

function setup(now = { t: 0 }) {
  const sent: string[] = [];
  const delivery: OtpDelivery = { send: async (_to, code) => void sent.push(code) };
  const svc = new OtpService(delivery, { ttlSeconds: 300, maxAttempts: 3, maxSends: 2, now: () => now.t });
  return { svc, sent, now };
}
const to = { channel: 'sms' as const, address: '+14045550101' };

describe('OTP', () => {
  it('verifies the right code', async () => {
    const { svc, sent } = setup();
    await svc.send('c1', '123456', to);
    expect(sent[0]).toMatch(/^\d{6}$/);
    expect(svc.verify('c1', sent[0]!)).toEqual({ verified: true });
    expect(svc.isVerified('c1')).toBe(true);
  });

  it('locks after 3 wrong attempts, even with the right code afterwards', async () => {
    const { svc, sent } = setup();
    await svc.send('c1', '123456', to);
    const wrong = sent[0] === '000000' ? '111111' : '000000';
    expect(svc.verify('c1', wrong)).toMatchObject({ verified: false, attemptsLeft: 2 });
    svc.verify('c1', wrong);
    expect(svc.verify('c1', wrong)).toMatchObject({ verified: false, reason: 'locked' });
    expect(svc.verify('c1', sent[0]!)).toMatchObject({ verified: false, reason: 'locked' });
  });

  it('does not reset attempts on resend and caps resends', async () => {
    const { svc, sent } = setup();
    await svc.send('c1', '123456', to);
    svc.verify('c1', 'x');
    svc.verify('c1', 'y');
    await svc.send('c1', '123456', to);
    expect(svc.verify('c1', 'z')).toMatchObject({ reason: 'locked' });
    expect(await svc.send('c1', '123456', to)).toMatchObject({ sent: false });
    expect(sent.length).toBe(2);
  });

  it('expires codes', async () => {
    const { svc, sent, now } = setup();
    await svc.send('c1', '123456', to);
    now.t = 301_000;
    expect(svc.verify('c1', sent[0]!)).toMatchObject({ verified: false, reason: 'expired' });
  });

  it('cannot verify a call that never had a code sent', () => {
    const { svc } = setup();
    expect(svc.verify('nope', '123456')).toMatchObject({ verified: false, reason: 'no_code' });
  });

  it('masks destinations', () => {
    expect(maskAddress('sms', '+1 (404) 555-0101')).toBe('***-***-0101');
    expect(maskAddress('email', 'dispatch@acme.com')).toBe('d***@acme.com');
  });
});
