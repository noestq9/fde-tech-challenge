import { z } from 'zod';

// All configuration comes from environment variables so secrets never live in code.
const ratio = z.coerce.number().min(0).max(1);

const schema = z.object({
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  // Shared secret the HappyRobot workflow sends in the X-API-Key header.
  API_KEY: z.string().min(24, 'API_KEY must be at least 24 characters'),

  // FMCSA: "live" calls the QCMobile API, "mock" uses local fixtures for demos and tests.
  FMCSA_MODE: z.enum(['live', 'mock']).default('mock'),
  FMCSA_WEB_KEY: z.string().optional(),
  FMCSA_BASE_URL: z.string().url().default('https://mobile.fmcsa.dot.gov/qc/services'),
  FMCSA_TIMEOUT_MS: z.coerce.number().int().default(4000),

  // TMS: "live" talks to the legacy TCP system, "mock" uses in-memory loads.
  TMS_MODE: z.enum(['live', 'mock']).default('mock'),
  TMS_HOST: z.string().optional(),
  TMS_PORT: z.coerce.number().int().optional(),
  TMS_TOKEN: z.string().optional(),
  TMS_CONNECT_TIMEOUT_MS: z.coerce.number().int().default(2000),
  // Per attempt. The real server's timeout fault stays silent for 30 s, so we give up much sooner.
  TMS_TIMEOUT_MS: z.coerce.number().int().default(3000),
  TMS_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
  // Total budget per operation including retries: the carrier is waiting on the line.
  TMS_BUDGET_MS: z.coerce.number().int().default(8000),
  TMS_MAX_RESULTS: z.coerce.number().int().min(1).max(50).default(10),
  TMS_BOOKING_JOURNAL: z.string().optional(),

  // OTP
  OTP_TTL_SECONDS: z.coerce.number().int().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().default(3),
  OTP_MAX_SENDS: z.coerce.number().int().default(2),
  // "console" logs the code (dev only). "webhook" posts it to a HappyRobot workflow that sends SMS/email.
  // "simulated" sends nothing and the code is always OTP_SIMULATED_CODE (demo environments without SMS/email).
  OTP_DELIVERY: z.enum(['console', 'webhook', 'simulated']).default('console'),
  OTP_SIMULATED_CODE: z.string().regex(/^\d{4,8}$/, 'OTP_SIMULATED_CODE must be 4 to 8 digits').default('1218'),
  OTP_WEBHOOK_URL: z.string().url().optional(),
  // HappyRobot API key (Settings -> API Keys) that the workflow's Webhook (API) trigger accepts.
  OTP_WEBHOOK_SECRET: z.string().optional(),
  // Demo only: send every OTP to this phone (E.164) or email instead of the carrier's contact.
  // Lets you receive codes yourself and avoids texting real carriers from FMCSA data. Refused in production.
  OTP_DEMO_CONTACT: z.string().min(5).max(254).optional(),

  // Negotiation: share of the (max_rate - loadboard_rate) gap conceded on each counter round.
  NEGOTIATION_STEPS: z
    .string()
    .default('0.35,0.70,1.0')
    .transform((s) => s.split(',').map((v) => ratio.parse(v.trim()))),
  RATE_ROUNDING: z.coerce.number().int().positive().default(5),
  // Opening offer = min(listed rate, ceiling x OPENING_RATIO).
  OPENING_RATIO: ratio.default(0.9),
  // Ceiling when the TMS does not expose MAX_BUY, as a share of the listed rate.
  FALLBACK_CEILING_RATIO: z.coerce.number().min(0.5).max(1.5).default(1.0),
  // How many loads to pitch per search (each one costs a LOAD_GET).
  LOADS_TO_PITCH: z.coerce.number().int().min(1).max(5).default(3),

  SESSION_TTL_SECONDS: z.coerce.number().int().default(3600),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty values (e.g. `TMS_HOST=` in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const cfg = schema.parse(cleaned);
  if (cfg.FMCSA_MODE === 'live' && !cfg.FMCSA_WEB_KEY) throw new Error('FMCSA_WEB_KEY is required when FMCSA_MODE=live');
  if (cfg.TMS_MODE === 'live' && !(cfg.TMS_HOST && cfg.TMS_PORT && cfg.TMS_TOKEN)) {
    throw new Error('TMS_HOST, TMS_PORT and TMS_TOKEN are required when TMS_MODE=live');
  }
  if (cfg.OTP_DELIVERY === 'webhook' && !(cfg.OTP_WEBHOOK_URL && cfg.OTP_WEBHOOK_SECRET)) {
    throw new Error('OTP_WEBHOOK_URL and OTP_WEBHOOK_SECRET are required when OTP_DELIVERY=webhook');
  }
  if (cfg.OTP_DEMO_CONTACT && env.NODE_ENV === 'production' && env.ALLOW_OTP_DEMO !== 'true') {
    throw new Error('OTP_DEMO_CONTACT is set in production. Remove it, or set ALLOW_OTP_DEMO=true for a demo deployment.');
  }
  if (cfg.OTP_DELIVERY === 'simulated' && env.NODE_ENV === 'production' && env.ALLOW_OTP_DEMO !== 'true') {
    throw new Error('OTP_DELIVERY=simulated accepts a fixed code. Set ALLOW_OTP_DEMO=true to use it in a demo deployment.');
  }
  if (cfg.NEGOTIATION_STEPS.length !== 3) throw new Error('NEGOTIATION_STEPS needs exactly 3 values (one per round)');
  return cfg;
}
