// Check MC numbers against the live FMCSA QCMobile API with your webKey.
//   npm run fmcsa:check -- 123456 MC-789012
import { LiveFmcsaClient, normalizeMc } from '../integrations/fmcsa.js';
import { loadDotEnv, need } from './env.js';

loadDotEnv();
const client = new LiveFmcsaClient(process.env.FMCSA_BASE_URL ?? 'https://mobile.fmcsa.dot.gov/qc/services', need('FMCSA_WEB_KEY'), 6000);
const mcs = process.argv.slice(2);
if (!mcs.length) {
  console.error('Usage: npm run fmcsa:check -- <MC> [MC...]');
  process.exit(2);
}

for (const input of mcs) {
  const mc = normalizeMc(input);
  if (!mc) {
    console.log(`${input}: invalid MC format`);
    continue;
  }
  const t0 = Date.now();
  const r = await client.verifyMc(mc);
  console.log(`MC ${mc} (${Date.now() - t0}ms): ${JSON.stringify(r)}`);
}
