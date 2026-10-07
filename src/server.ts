import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { CallSessionStore, summarize, type Outcome } from './domain/callSession.js';
import { StaticCarrierDirectory, type CarrierDirectory } from './domain/carrierDirectory.js';
import { applyMove, startNegotiation, type NegotiationPolicy } from './domain/negotiation.js';
import { OtpService, maskAddress, type OtpDelivery } from './domain/otp.js';
import { LiveFmcsaClient, MockFmcsaClient, normalizeMc, type FmcsaClient } from './integrations/fmcsa.js';
import { ConsoleOtpDelivery, WebhookOtpDelivery } from './integrations/otpDelivery.js';
import { MockTms } from './integrations/tms/mockTms.js';
import { TmsError, toPublicLoad, type TmsClient } from './integrations/tms/types.js';

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
    logger: { level: cfg.LOG_LEVEL, redact: ['req.headers["x-api-key"]', 'req.headers.authorization'] },
    genReqId: () => randomUUID(),
  });

  const fmcsa = deps.fmcsa ?? (cfg.FMCSA_MODE === 'live' ? new LiveFmcsaClient(cfg.FMCSA_BASE_URL, cfg.FMCSA_WEB_KEY!, cfg.FMCSA_TIMEOUT_MS) : new MockFmcsaClient());
  const tms = deps.tms ?? new MockTms();
  const delivery =
    deps.otpDelivery ??
    (cfg.OTP_DELIVERY === 'webhook' ? new WebhookOtpDelivery(cfg.OTP_WEBHOOK_URL!, cfg.OTP_WEBHOOK_SECRET!) : new ConsoleOtpDelivery(app.log));
  const directory = deps.directory ?? new StaticCarrierDirectory();
  const otp = new OtpService(delivery, { ttlSeconds: cfg.OTP_TTL_SECONDS, maxAttempts: cfg.OTP_MAX_ATTEMPTS, maxSends: cfg.OTP_MAX_SENDS, now: deps.now });
  const sessions = new CallSessionStore(cfg.SESSION_TTL_SECONDS, deps.now);
  const policy: NegotiationPolicy = { steps: cfg.NEGOTIATION_STEPS, rounding: cfg.RATE_ROUNDING };

  // --- Auth: every route except /health needs the shared API key. ---
  const expected = Buffer.from(cfg.API_KEY);
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
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

  app.get('/health', async () => ({ ok: true, fmcsa: cfg.FMCSA_MODE, tms: cfg.TMS_MODE }));

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

    // Destination priority: carrier record on file, then FMCSA phone, then (new carriers only) what the caller gives.
    let dest: { channel: 'sms' | 'email'; address: string; source: 'directory' | 'fmcsa' | 'caller_provided' } | null = null;
    const onFile = await directory.contactFor(s.mcNumber);
    if (onFile) dest = { ...onFile, source: 'directory' };
    else if (s.carrier?.phone) dest = { channel: 'sms', address: s.carrier.phone, source: 'fmcsa' };
    else if (body.caller_contact) {
      const channel = body.caller_contact.includes('@') ? 'email' : 'sms';
      dest = { channel, address: body.caller_contact, source: 'caller_provided' };
    }
    if (!dest) {
      return { ok: false, error: 'no_contact_on_file', agent_guidance: 'Ask for a mobile number or email to send the verification code to.' };
    }

    const masked = maskAddress(dest.channel, dest.address);
    try {
      const r = await otp.send(callId, s.mcNumber, dest);
      if (!r.sent) {
        close(s, 'otp_failed', r.reason);
        return { ok: false, error: r.reason, agent_guidance: 'Verification is locked for this call. Explain a rep will follow up, and end the call. Do not continue without verification.' };
      }
      s.otp = { channel: dest.channel, masked, source: dest.source };
      sessions.event(s, 'otp_sent', { channel: dest.channel, source: dest.source });
      return { ok: true, sent: true, channel: dest.channel, sent_to: masked, expires_in_seconds: r.expiresInSeconds, agent_guidance: `Tell them a 6-digit code was sent to ${masked} and ask them to read it back.` };
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

  // 3. Load search (gated on OTP)
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
    try {
      const loads = await tms.searchLoads({ origin: body.origin, destination: body.destination, equipmentType: body.equipment_type });
      s.search = { origin: body.origin, destination: body.destination, equipmentType: body.equipment_type, resultCount: loads.length };
      const top = loads.slice(0, 3);
      s.loadsOffered.push(...top.map((l) => l.loadId));
      sessions.event(s, 'loads_searched', { count: loads.length });
      if (!loads.length) {
        close(s, 'no_loads');
        return { ok: true, loads: [], agent_guidance: 'No matching loads right now. Offer to note their lane and have a rep reach out.' };
      }
      return { ok: true, loads: top.map(toPublicLoad), agent_guidance: 'Pitch the best match briefly: lane, pickup time, equipment, weight, and the rate. Ask if they want it.' };
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
    if (!s.loadsOffered.includes(loadId)) return { ok: false, error: 'load_not_offered', agent_guidance: 'Only negotiate on loads you pitched in this call.' };

    let state = s.negotiations[loadId];
    if (!state) {
      try {
        const load = await tms.getLoad(loadId);
        if (!load) return { ok: false, error: 'load_not_found', agent_guidance: 'That load is no longer available. Offer to search again.' };
        state = startNegotiation(load.loadboardRate, load.maxRate);
      } catch (err) {
        return tmsFailure(s, err);
      }
    }

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
    if (s.booking) return { ok: true, already_booked: true, confirmation: s.booking.confirmation, handoff_id: s.booking.handoffId };
    try {
      const b = await tms.bookLoad(loadId, s.mcNumber, n.agreedRate);
      const handoffId = `HO-${randomUUID().slice(0, 8).toUpperCase()}`;
      s.booking = { loadId, rate: n.agreedRate, confirmation: b.confirmation, handoffId };
      close(s, 'booked');
      req.log.info({ callId, loadId, handoffId }, 'senior rep handoff (mocked)');
      return { ok: true, booked: true, load_id: loadId, rate: n.agreedRate, confirmation: b.confirmation, handoff_id: handoffId, agent_guidance: 'Tell them the load is reserved and a senior rep will contact them to confirm and collect paperwork. Close the call.' };
    } catch (err) {
      if (err instanceof TmsError && err.kind === 'rejected') {
        return { ok: false, error: 'load_taken', agent_guidance: 'Apologize, that load was just taken. Offer to search for another one.' };
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
