/** Loads .env from the current directory if present (scripts only; the server reads real env vars). */
export function loadDotEnv() {
  try {
    process.loadEnvFile('.env');
  } catch {
    // no .env: rely on the environment
  }
}

export function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Put it in .env (see .env.example).`);
    process.exit(2);
  }
  return v;
}
