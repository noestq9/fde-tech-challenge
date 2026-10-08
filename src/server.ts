import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { CallSessionStore, summarize, type OtpSource, type Outcome } from './domain/callSession.js';
import { StaticCarrierDirectory, type CarrierDirectory } from './domain/carrierDirectory.js';
import { applyMove, priceLoad, startNegotiation, type NegotiationPolicy } from './domain/negotiation.js';
import { OtpService, maskAddress, type OtpDelivery } from './domain/otp.js';
import { LiveFmcsaClient, MockFmcsaClient, normalizeMc, type FmcsaClient } from './integrations/fmcsa.js';
import { ConsoleOtpDelivery, SimulatedOtpDelivery, WebhookOtpDelivery } from './integrations/otpDelivery.js';
import { MockTms } from './integrations/tms/mockTms.js';
import { LtmsClient } from './integrations/tms/ltmsClient.js';
import { TmsError, type Load, type TmsClient } from './integrations/tms/types.js';

export interface Deps {
  fmcsa?: FmcsaClient;
  tms?: TmsClient;
  otpDelivery?: OtpDelivery;
  directory?: CarrierDirectory;
  now?: () => number;
}

// Business outcomes come back as HTTP 200 with ok:false and a short `agent_guidance` line, so the voice agent
// always gets a structured answer it can act on instead of a generic tool failure it might improvise around.
// 4xx is reserved for auth and malformed requests.

export function buildServer(cfg: Config, deps: Deps = {}): FastifyInstance {
  const app = Fastify({
    ignoreTrailingSlash: true,
    logger: { level: cfg.LOG_LEVEL, redact: ['req.headers["x-api-key"]', 'req.headers.authorization'] },
    genReqId: () => randomUUID(),
  });

  const fmcsa = deps.fmcsa ?? (cfg.FMCSA_MODE === 'live' ? new LiveFmcsaClient(cfg.FMCSA_BASE_URL, cfg.FMCSA_WEB_KEY!, cfg.FMCSA_TIMEOUT_MS) : new MockFmcsaClient());
  const tms =
    deps.tms ??
    (cfg.TMS_MODE === 'live'
      ? new LtmsClient({
          host: cfg.TMS_HOST!, port: cfg.TMS_PORT!, token: cfg.TMS_TOKEN!, connectTimeoutMs: cfg.TMS_CONNECT_TIMEOUT_MS,
          requestTimeoutMs: cfg.TMS_TIMEOUT_MS, retries: cfg.TMS_RETRIES, budgetMs: cfg.TMS_BUDGET_MS, maxResults: cfg.TMS_MAX_RESULTS,
          bookingJournalPath: cfg.TMS_BOOKING_JOURNAL, logger: app.log,
        })
      : new MockTms());
  const delivery =
    deps.otpDelivery ??
    (cfg.OTP_DELIVERY === 'webhook'
      ? new WebhookOtpDelivery(cfg.OTP_WEBHOOK_URL!, cfg.OTP_WEBHOOK_SECRET!)
      : cfg.OTP_DELIVERY === 'simulated'
        ? new SimulatedOtpDelivery(app.log)
        : new ConsoleOtpDelivery(app.log));
  const simulatedOtp = cfg.OTP_DELIVERY === 'simulated';
  const directory = deps.directory ?? new StaticCarrierDirectory();
  const otp = new OtpService(delivery, { ttlSeconds: cfg.OTP_TTL_SECONDS, maxAttempts: cfg.OTP_MAX_ATTEMPTS, maxSends: cfg.OTP_MAX_SENDS,
    fixedCode: simulatedOtp ? cfg.OTP_SIMULATED_CODE : undefined, now: deps.now,
  });
  const sessions = new CallSessionStore(cfg.SESSION_TTL_SECONDS, deps.now);
  const policy: NegotiationPolicy = {
    steps: cfg.NEGOTIATION_STEPS, rounding: cfg.RATE_ROUNDING, openingRatio: cfg.OPENING_RATIO, fallbackCeilingRatio: cfg.FALLBACK_CEILING_RATIO,
  };

  // --- Auth: every route except /health needs the shared API key. ---
  const expected = Buffer.from(cfg.API_KEY);
  app.addHook('onRequest', async (req, reply) => {
    // Match on the routed path, so /health?x=1 and /health/ are public too. Unknown routes still need the key.
    if (req.routeOptions.url === '/health') return;
    const given = Buffer.from(String(req.headers['x-api-key'] ?? ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ ok: false, error: 'invalid_request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ ok: false, error: 'internal_error', agent_guidance: 'Apologize, say there is a system issue, and offer to have a rep call them back.' });
  });

  // Workflow tools template every parameter into the body, so an unused optional one can arrive as "" or "null".
  // Treat those as absent instead of failing validation.
  app.addHook('preValidation', async (req) => {
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      const b = req.body as Record<string, unknown>;
      for (const [k, v] of Object.entries(b)) {
        if (v === null || (typeof v === 'string' && ['', 'null', 'undefined', 'none'].includes(v.trim().toLowerCase()))) delete b[k];
      }
    }
  });

  app.get('/health', async () => ({ ok: true, fmcsa: cfg.FMCSA_MODE, tms: cfg.TMS_MODE, otp: cfg.OTP_DELIVERY }));

  const callParams = z.object({ callId: z.string().min(1).max(128) });
  const close = (s: ReturnType<typeof sessions.get>, outcome: Outcome, reason?: string) => {
    s.outcome = outcome;
    s.failureReason = reason;
    sessions.event(s, 'outcome', { outcome, reason });
  };
  const tmsFailure = (s: ReturnType<typeof sessions.get>, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    s.integrationErrors.push({ system: 'tms', error: msg, at: new Date().toISOString() });
    sessions.event(s, 'tms_error', { error: msg });
    if (err instanceof TmsError && err.kind === 'auth') app.log.error('TMS rejected our token: rotate TMS_TOKEN');
    return {
      ok: false,
      error: 'tms_unavailable',
      agent_guidance: 'The load system is not responding. Do not guess any load details. Apologize and offer to have a rep call them back shortly.',
    };
  };

  // 1. FMCSA authority check
  app.post('/v1/calls/:callId/verify-carrier', async (req) => {
    const { callId } = callParams.parse(req.params);
    const body = z.object({ mc_number: z.union([z.string(), z.number()]) }).parse(req.body);
    const s = sessions.get(callId);
    const mc = normalizeMc(String(body.mc_number));
    if (!mc) return { ok: false, error: 'invalid_mc', agent_guidance: 'Ask the carrier to repeat their MC number digit by digit.' };

    const res = await fmcsa.verifyMc(mc);
    s.mcNumber = mc;
    s.fmcsaStatus = res.status;
    sessions.event(s, 'fmcsa_checked', { mc, status: res.status });

    switch (res.status) {
      case 'eligible':
        s.carrier = res.carrier;
        return { ok: true, eligible: true, mc_number: mc, carrier_name: res.carrier.legalName ?? null, agent_guidance: 'Confirm the company name with the carrier, then send the verification code.' };
      case 'not_eligible':
        s.carrier = res.carrier;
        s.fmcsaReasons = res.reasons;
        close(s, 'fmcsa_failed', res.reasons.join(','));
        return { ok: true, eligible: false, mc_number: mc, reasons: res.reasons, agent_guidance: 'Politely explain we can only work with carriers with active operating authority, and end the call.' };
      case 'not_found':
        return { ok: true, eligible: false, mc_number: mc, reasons: ['mc_not_found'], agent_guidance: 'Read the MC number back and ask them to confirm it. If it is still not found, end the call politely.' };
      case 'unavailable':
        s.integrationErrors.push({ system: 'fmcsa', error: res.error, at: new Date().toISOString() });
        close(s, 'integration_error', 'fmcsa_unavailable');
        return { ok: false, error: 'fmcsa_unavailable', agent_guidance: 'We cannot verify authority right now. Apologize and offer a callback from a rep. Do not continue to loads.' };
    }
  });

  // 2a. Send OTP to the contact on file
  app.post('/v1/calls/:callId/otp/send', async (req) => {
    const { callId } = callParams.parse(req.params);
    const body = z
      .object({ channel: z.enum(['sms', 'email']).optional(), caller_contact: z.string().min(5).max(254).optional() })
      .parse(req.body ?? {});
    const s = sessions.get(callId);
    if (s.fmcsaStatus !== 'eligible' || !s.mcNumber) {
      return { ok: false, error: 'carrier_not_verified', agent_guidance: 'Verify the MC number first.' };
    }

    // Destination priority: demo override (never in production), carrier record on file, FMCSA phone,
    // then (new carriers only) what the caller gives.
    let dest: { channel: 'sms' | 'email'; address: string; source: OtpSource } | null = null;
    const onFile = await directory.contactFor(s.mcNumber);
    // Simulated OTP: nothing is sent, so no real contact is needed.
    if (simulatedOtp) dest = { channel: 'sms', address: 'simulated', source: 'simulated' };
    else if (cfg.OTP_DEMO_CONTACT) dest = { channel: cfg.OTP_DEMO_CONTACT.includes('@') ? 'email' : 'sms', address: cfg.OTP_DEMO_CONTACT, source: 'demo' };
    else if (onFile) dest = { ...onFile, source: 'directory' };
    else if (s.carrier?.phone) dest = { channel: 'sms', address: s.carrier.phone, source: 'fmcsa' };
    else if (body.caller_contact) {
      const channel = body.caller_contact.includes('@') ? 'email' : 'sms';
      dest = { channel, address: body.caller_contact, source: 'caller_provided' };
    }
    if (!dest) {
      return { ok: false, error: 'no_contact_on_file', agent_guidance: 'Ask for a mobile number or email to send the verification code to.' };
    }

    const masked = simulatedOtp ? 'the phone number on file' : maskAddress(dest.channel, dest.address);
    try {
      const r = await otp.send(callId, s.mcNumber, dest);
      if (!r.sent) {
        close(s, 'otp_failed', r.reason);
        return { ok: false, error: r.reason, agent_guidance: 'Verification is locked for this call. Explain a rep will follow up, and end the call. Do not continue without verification.' };
      }
      s.otp = { channel: dest.channel, masked, source: dest.source };
      sessions.event(s, 'otp_sent', { channel: dest.channel, source: dest.source });
      return { ok: true, sent: true, channel: dest.channel, sent_to: masked, expires_in_seconds: r.expiresInSeconds, agent_guidance: `Tell them a verification code was sent to ${masked} and ask them to read it back.` };
    } catch (err) {
      s.integrationErrors.push({ system: 'otp', error: String(err), at: new Date().toISOString() });
      return { ok: false, error: 'otp_delivery_failed', agent_guidance: 'The code could not be sent. Apologize, offer to try once more, otherwise offer a rep callback.' };
    }
  });

  // 2b. Verify OTP
  app.post('/v1/calls/:callId/otp/verify', async (req) => {
    const { callId } = callParams.parse(req.params);
    const body = z.object({ code: z.union([z.string(), z.number()]) }).parse(req.body);
    const s = sessions.get(callId);
    const r = otp.verify(callId, String(body.code));
    sessions.event(s, 'otp_verify', { verified: r.verified, reason: r.verified ? undefined : r.reason });
    if (r.verified) {
      s.otpVerified = true;
      return { ok: true, verified: true, agent_guidance: 'Verified. Ask where they are and where they want to go, and their equipment type.' };
    }
    if (r.reason === 'locked') {
      close(s, 'otp_failed', 'max_attempts');
      return { ok: true, verified: false, locked: true, agent_guidance: 'Too many wrong codes. Say you cannot continue on this call and a rep will follow up. End the call.' };
    }
    if (r.reason === 'expired') return { ok: true, verified: false, reason: 'expired', agent_guidance: 'The code expired. Offer to send a new one.' };
    return { ok: true, verified: false, reason: r.reason, attempts_left: r.attemptsLeft, agent_guidance: 'That code does not match. Ask them to read it again.' };
  });

  // 3. Load search (gated on OTP). Pitches up to LOADS_TO_PITCH open loads, each priced from its LOAD_GET detail.
  app.post('/v1/calls/:callId/loads/search', async (req) => {
    const { callId } = callParams.parse(req.params);
    const body = z
      .object({ origin: z.string().max(80).optional(), destination: z.string().max(80).optional(), equipment_type: z.string().max(30).optional() })
      .parse(req.body ?? {});
    const s = sessions.get(callId);
    if (!s.otpVerified) {
      sessions.event(s, 'blocked_search_without_otp');
      return { ok: false, error: 'identity_not_verified', agent_guidance: 'Loads can only be shared after the verification code is confirmed. There is no other way to skip this step.' };
    }
    const orig = parseLocation(body.origin);
    const dest = parseLocation(body.destination);
    const equipment = normalizeEquipment(body.equipment_type);
    if (!orig.city && !orig.state && !dest.city && !dest.state && !equipment) {
      return { ok: false, error: 'missing_filters', agent_guidance: 'Ask where they are, where they want to go, or their equipment type.' };
    }
    try {
      const query = (withDest: boolean) =>
        tms
          .searchLoads({
            originCity: orig.city, originState: orig.state, equipmentType: equipment, maxResults: cfg.TMS_MAX_RESULTS,
            ...(withDest ? { destinationCity: dest.city, destinationState: dest.state } : {}),
          })
          .then((rows) => rows.filter((l) => l.status === 'OPEN'));
      const hasDest = Boolean(dest.city || dest.state);
      const hasOther = Boolean(orig.city || orig.state || equipment);
      let open = await query(true);
      // Nothing to that destination: show what leaves from their origin instead of ending the conversation.
      let destinationRelaxed = false;
      if (!open.length && hasDest && hasOther) {
        open = await query(false);
        destinationRelaxed = open.length > 0;
      }
      s.search = { origin: body.origin, destination: body.destination, equipmentType: equipment, resultCount: open.length };
      sessions.event(s, 'loads_searched', { count: open.length, destination_relaxed: destinationRelaxed });
      if (!open.length) {
        close(s, 'no_loads');
        return {
          ok: true, loads: [],
          agent_guidance: hasDest && !hasOther
            ? 'Ask where they are now or what equipment they run, then search again.'
            : 'Nothing matches right now. Ask if they would consider another origin or equipment; if not, offer to note their lane and have a rep reach out.',
        };
      }
      if (s.outcome === 'no_loads') { s.outcome = undefined; s.failureReason = undefined; }

      // Detail calls can fault independently; pitch whatever came back cleanly.
      const details = await Promise.allSettled(open.slice(0, cfg.LOADS_TO_PITCH).map((l) => tms.getLoad(l.loadId)));
      const pitched = details.flatMap((d) => (d.status === 'fulfilled' && d.value && d.value.status === 'OPEN' ? [d.value] : []));
      const failed = details.filter((d) => d.status === 'rejected');
      if (failed.length) s.integrationErrors.push({ system: 'tms', error: `${failed.length} LOAD_GET failed during search`, at: new Date().toISOString() });
      if (!pitched.length) return tmsFailure(s, (failed[0] as PromiseRejectedResult | undefined)?.reason ?? new Error('no load details'));

      const loads = pitched.map((l) => {
        s.pricing[l.loadId] = priceLoad(l.loadboardRate, l.maxRate, policy);
        if (!s.loadsOffered.includes(l.loadId)) s.loadsOffered.push(l.loadId);
        return toAgentLoad(l, s.pricing[l.loadId]!.opening);
      });
      const pitch = 'Pitch the first load briefly: lane, pickup time, equipment, weight, and offer_rate. Ask if it works for them.';
      return destinationRelaxed
        ? { ok: true, loads, destination_relaxed: true, agent_guidance: `Nothing is going to ${body.destination} right now. Say so in one sentence, then offer these loads from their area instead. ${pitch}` }
        : { ok: true, loads, agent_guidance: pitch };
    } catch (err) {
      return tmsFailure(s, err);
    }
  });

  // 4. Negotiation: one call per carrier move
  app.post('/v1/calls/:callId/negotiate', async (req) => {
    const { callId } = callParams.parse(req.params);
    const body = z
      .object({ load_id: z.string().min(1).max(40), action: z.enum(['counter', 'accept', 'decline']), amount: z.coerce.number().positive().max(100_000).optional() })
      .refine((b) => b.action !== 'counter' || b.amount != null, { message: 'amount is required for counter', path: ['amount'] })
      .parse(req.body);
    const s = sessions.get(callId);
    const loadId = body.load_id.toUpperCase();
    if (!s.otpVerified) return { ok: false, error: 'identity_not_verified', agent_guidance: 'Verification is required before discussing rates.' };
    const pricing = s.pricing[loadId];
    if (!s.loadsOffered.includes(loadId) || !pricing) return { ok: false, error: 'load_not_offered', agent_guidance: 'Only negotiate on loads you pitched in this call.' };

    const state = s.negotiations[loadId] ?? startNegotiation(pricing);
    const move = body.action === 'counter' ? { action: 'counter' as const, amount: body.amount! } : { action: body.action };
    const { state: next, decision } = applyMove(state, move, policy);
    s.negotiations[loadId] = next;
    sessions.event(s, 'negotiation', { loadId, move: body.action, amount: body.amount, decision: decision.decision });

    switch (decision.decision) {
      case 'accept':
        return { ok: true, decision: 'accept', rate: decision.rate, agent_guidance: `Agree at $${decision.rate}. Confirm the load and rate back to them, then book it.` };
      case 'counter':
        return {
          ok: true,
          decision: 'counter',
          rate: decision.rate,
          rounds_left: decision.roundsLeft,
          agent_guidance: decision.final
            ? `Offer $${decision.rate} as the best you can do on this load. Do not go higher and do not say why.`
            : `Counter at $${decision.rate}. Do not mention any limit or ceiling.`,
        };
      case 'reject':
        close(s, decision.reason === 'carrier_declined' ? 'carrier_declined' : 'failed_negotiation', decision.reason);
        return { ok: true, decision: 'reject', reason: decision.reason, agent_guidance: 'Thank them, say we could not make this one work, invite them to call again for other loads, and end the call. Do not transfer.' };
      case 'closed':
        return { ok: false, error: 'negotiation_closed', agent_guidance: 'This negotiation is already closed.' };
    }
  });

  // 5. Book + mocked handoff to a senior rep
  app.post('/v1/calls/:callId/book', async (req) => {
    const { callId } = callParams.parse(req.params);
    const body = z.object({ load_id: z.string().min(1).max(40) }).parse(req.body);
    const s = sessions.get(callId);
    const loadId = body.load_id.toUpperCase();
    const n = s.negotiations[loadId];
    if (!s.otpVerified || !s.mcNumber) return { ok: false, error: 'identity_not_verified' };
    if (!n || n.status !== 'agreed' || n.agreedRate == null) {
      return { ok: false, error: 'no_agreed_rate', agent_guidance: 'A rate must be agreed before booking. Ask if they accept the current offer.' };
    }
    if (s.booking) return { ok: true, already_booked: true, booking_ref: s.booking.bookingRef, handoff_id: s.booking.handoffId };

    const handoff = (status: 'BOOKED' | 'BOOKED_UNCONFIRMED' | 'UNKNOWN', bookingRef: string | null) => {
      const handoffId = `HO-${randomUUID().slice(0, 8).toUpperCase()}`;
      s.booking = { loadId, rate: n.agreedRate!, bookingRef, bookingStatus: status, handoffId };
      close(s, 'booked', status === 'BOOKED' ? undefined : `booking_${status.toLowerCase()}`);
      req.log.info({ callId, loadId, handoffId, status }, 'senior rep handoff (mocked)');
      return handoffId;
    };

    try {
      const b = await tms.bookLoad(loadId, s.mcNumber, n.agreedRate);
      const handoffId = handoff(b.status, b.bookingRef);
      return {
        ok: true, booked: true, load_id: loadId, rate: n.agreedRate, booking_ref: b.bookingRef, handoff_id: handoffId,
        agent_guidance: 'Tell them the load is reserved at the agreed rate and a senior rep will contact them to confirm and collect paperwork. Close the call.',
      };
    } catch (err) {
      if (err instanceof TmsError) {
        if (err.kind === 'not_available') return { ok: false, error: 'load_taken', agent_guidance: 'Apologize, that load was just taken. Offer to search for another one.' };
        if (err.kind === 'rate_rejected') {
          s.integrationErrors.push({ system: 'tms', error: 'INVALID_RATE on booking', at: new Date().toISOString() });
          close(s, 'integration_error', 'rate_rejected_by_tms');
          return { ok: false, error: 'booking_rejected', agent_guidance: 'Say you need a senior rep to finalize this one and they will call back shortly. Do not change the rate.' };
        }
        if (err.kind === 'booking_unknown') {
          // The reservation may have gone through. Hand off anyway; the rep confirms against the TMS.
          const handoffId = handoff('UNKNOWN', null);
          return { ok: true, booked: false, pending_confirmation: true, handoff_id: handoffId, agent_guidance: 'Tell them the rate is agreed and a senior rep will confirm the reservation with them shortly. Close the call.' };
        }
      }
      return tmsFailure(s, err);
    }
  });

  // 6. Call summary: the workflow writes this record to Twin when the call ends.
  app.post('/v1/calls/:callId/finalize', async (req) => {
    const { callId } = callParams.parse(req.params);
    const body = z.object({ notes: z.string().max(2000).optional(), sentiment: z.enum(['positive', 'neutral', 'negative']).optional() }).parse(req.body ?? {});
    const s = sessions.get(callId);
    sessions.event(s, 'finalized');
    return { ok: true, record: { ...summarize(s), sentiment: body.sentiment ?? null, notes: body.notes ?? null } };
  });

  app.get('/v1/calls/:callId', async (req) => {
    const { callId } = callParams.parse(req.params);
    return { ok: true, record: summarize(sessions.get(callId)) };
  });

  return app;
}

const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));

const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};
// Callers who don't care where they go: treat as "no destination filter".
const ANYWHERE = /^(any(where| place| city| state| destination)?|open|flexible|wherever|doesn'?t matter|no preference|not sure|n\/?a|everywhere)$/i;

/**
 * Spoken locations to TMS filters. "Atlanta, GA" / "Atlanta GA" / "Atlanta, Georgia" → city + state;
 * "GA" / "Georgia" → state; "Atlanta" → city; "anywhere" → no filter.
 */
export function parseLocation(input?: string): { city?: string; state?: string } {
  const v = (input ?? '').replace(/[|\r\n]/g, ' ').replace(/\s+/g, ' ').replace(/[.,\s]*(usa|us|united states)\.?$/i, '').replace(/[.\s]+$/, '').trim();
  if (!v || ANYWHERE.test(v)) return {};
  const lower = v.toLowerCase();
  if (STATE_NAMES[lower]) return { state: STATE_NAMES[lower] };
  if (US_STATES.has(v.toUpperCase())) return { state: v.toUpperCase() };
  for (const [name, code] of Object.entries(STATE_NAMES)) {
    if (lower.endsWith(` ${name}`) || lower.endsWith(`,${name}`)) {
      const city = v.slice(0, v.length - name.length).replace(/[,\s]+$/, '').trim();
      return { city: city || undefined, state: code };
    }
  }
  const m = v.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
  if (m && US_STATES.has(m[2]!.toUpperCase())) return { city: m[1]!.trim() || undefined, state: m[2]!.toUpperCase() };
  return { city: v };
}

export function normalizeEquipment(input?: string): string | undefined {
  const v = (input ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!v) return undefined;
  if (v.includes('reefer') || v.includes('refrigerat')) return 'REEFER';
  if (v.includes('flat')) return 'FLATBED';
  if (v.includes('power')) return 'POWER_ONLY';
  if (v.includes('van') || v.includes('dry')) return 'DRY_VAN';
  return v.toUpperCase();
}

/** The only load shape the agent ever sees: no listed-vs-ceiling data, just what to pitch. */
function toAgentLoad(l: Load, offerRate: number) {
  return {
    load_id: l.loadId,
    origin: l.origin,
    destination: l.destination,
    pickup_datetime: l.pickupDatetime,
    delivery_datetime: l.deliveryDatetime,
    equipment_type: l.equipmentType,
    offer_rate: offerRate,
    miles: l.miles,
    weight_lbs: l.weight,
    commodity: l.commodityType,
    pieces: l.numOfPieces,
    dimensions: l.dimensions,
    notes: l.notes,
  };
}
