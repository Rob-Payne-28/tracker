import path from 'node:path';

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  databaseFile: string;
  baseUrl: string;
  /** Whether anyone may create an account. The first account is always allowed and becomes admin. */
  allowSignup: boolean;
  maxUploadBytes: number;
  sessionDays: number;
  smtpUrl: string | null;
  mailFrom: string;
  webDist: string | null;
  logLevel: string;
  trustProxy: boolean;
  /** Allow webhooks to private/loopback/link-local addresses (SSRF risk; off by default). */
  webhookAllowPrivate: boolean;
  /** Maximum concurrent realtime streams per user. */
  maxStreamsPerUser: number;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  const dataDir = overrides.dataDir ?? path.resolve(env.DATA_DIR ?? './data');
  const port = Number(env.PORT ?? 3000);
  const cfg: Config = {
    port,
    host: env.HOST ?? '0.0.0.0',
    dataDir,
    databaseFile: env.DATABASE_FILE ?? path.join(dataDir, 'tracker.db'),
    baseUrl: (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    allowSignup: bool(env.ALLOW_SIGNUP, true),
    maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 50) * 1024 * 1024,
    sessionDays: Number(env.SESSION_DAYS ?? 30),
    smtpUrl: env.SMTP_URL || null,
    mailFrom: env.MAIL_FROM ?? 'Tracker <tracker@localhost>',
    webDist: env.WEB_DIST ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../web/dist'),
    logLevel: env.LOG_LEVEL ?? 'info',
    trustProxy: bool(env.TRUST_PROXY, false),
    webhookAllowPrivate: bool(env.WEBHOOK_ALLOW_PRIVATE, false),
    maxStreamsPerUser: Number(env.MAX_STREAMS_PER_USER ?? 20),
    ...overrides,
  };
  validateConfig(cfg);
  return cfg;
}

/** Fail fast on misconfiguration instead of misbehaving later. */
export function validateConfig(cfg: Config) {
  const problems: string[] = [];
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) problems.push(`PORT must be 0-65535 (got ${cfg.port})`);
  try {
    const u = new URL(cfg.baseUrl);
    if (!['http:', 'https:'].includes(u.protocol)) problems.push('BASE_URL must be an http(s) URL');
  } catch {
    problems.push(`BASE_URL is not a valid URL (got "${cfg.baseUrl}")`);
  }
  if (!(cfg.maxUploadBytes > 0)) problems.push('MAX_UPLOAD_MB must be a positive number');
  if (!(cfg.sessionDays > 0)) problems.push('SESSION_DAYS must be a positive number');
  if (!(cfg.maxStreamsPerUser > 0)) problems.push('MAX_STREAMS_PER_USER must be a positive number');
  if (problems.length) throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
}
