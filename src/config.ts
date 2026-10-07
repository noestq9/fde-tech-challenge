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
  TMS_TIMEOUT_MS: z.coerce.number().int().default(3000),
  TMS_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  // OTP
  OTP_TTL_SECONDS: z.coerce.number().int().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().default(3),
  OTP_MAX_SENDS: z.coerce.number().int().default(2),
  // "console" logs the code (dev only). "webhook" posts it to a HappyRobot workflow that sends SMS/email.
  OTP_DELIVERY: z.enum(['console', 'webhook']).default('console'),
  OTP_WEBHOOK_URL: z.string().url().optional(),
  OTP_WEBHOOK_SECRET: z.string().optional(),

  // Negotiation: share of the (max_rate - loadboard_rate) gap conceded on each counter round.
  NEGOTIATION_STEPS: z
    .string()
    .default('0.35,0.70,1.0')
    .transform((s) => s.split(',').map((v) => ratio.parse(v.trim()))),
  RATE_ROUNDING: z.coerce.number().int().positive().default(5),

  SESSION_TTL_SECONDS: z.coerce.number().int().default(3600),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = schema.parse(env);
  if (cfg.FMCSA_MODE === 'live' && !cfg.FMCSA_WEB_KEY) throw new Error('FMCSA_WEB_KEY is required when FMCSA_MODE=live');
  if (cfg.TMS_MODE === 'live' && !(cfg.TMS_HOST && cfg.TMS_PORT && cfg.TMS_TOKEN)) {
    throw new Error('TMS_HOST, TMS_PORT and TMS_TOKEN are required when TMS_MODE=live');
  }
  if (cfg.OTP_DELIVERY === 'webhook' && !(cfg.OTP_WEBHOOK_URL && cfg.OTP_WEBHOOK_SECRET)) {
    throw new Error('OTP_WEBHOOK_URL and OTP_WEBHOOK_SECRET are required when OTP_DELIVERY=webhook');
  }
  if (cfg.NEGOTIATION_STEPS.length !== 3) throw new Error('NEGOTIATION_STEPS needs exactly 3 values (one per round)');
  return cfg;
}
