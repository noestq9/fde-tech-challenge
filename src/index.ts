import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const cfg = loadConfig();
const app = buildServer(cfg);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

app.listen({ port: cfg.PORT, host: cfg.HOST }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
