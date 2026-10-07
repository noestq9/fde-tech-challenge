import { startFakeTms, type FaultKind } from './server.js';

const port = Number(process.env.FAKE_TMS_PORT ?? 9100);
const token = process.env.FAKE_TMS_TOKEN ?? 'dev-token';
const faultRate = Number(process.env.FAKE_TMS_FAULT_RATE ?? 0.2);
const faults = (process.env.FAKE_TMS_FAULTS ?? 'timeout,partial,malformed,delayed').split(',').map((s) => s.trim()) as FaultKind[];
const exposeMaxBuy = (process.env.FAKE_TMS_EXPOSE_MAX_BUY ?? 'true') === 'true';
const idleTimeoutMs = Number(process.env.FAKE_TMS_IDLE_MS ?? 30_000);

startFakeTms(port, { token, faultRate, faults, exposeMaxBuy, idleTimeoutMs }).then(({ port: p }) => {
  console.log(`fake LTMS listening on :${p} (faultRate=${faultRate}, faults=${faults.join('/')}, maxBuy=${exposeMaxBuy})`);
});
