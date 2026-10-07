// Contact on file for each carrier: where the OTP is sent. In production this is the carrier record in Twin
// (or the TMS carrier master); FMCSA's phone on record is the fallback.
// The caller never gets to choose the destination for a carrier we already know.

export interface CarrierDirectory {
  contactFor(mcNumber: string): Promise<{ channel: 'sms' | 'email'; address: string } | null>;
}

export class StaticCarrierDirectory implements CarrierDirectory {
  constructor(private readonly contacts: Record<string, { channel: 'sms' | 'email'; address: string }> = DEMO_CONTACTS) {}
  async contactFor(mcNumber: string) {
    return this.contacts[mcNumber] ?? null;
  }
}

const DEMO_CONTACTS: Record<string, { channel: 'sms' | 'email'; address: string }> = {
  '234567': { channel: 'email', address: 'dispatch@lakeshore-reefer.example' },
};
