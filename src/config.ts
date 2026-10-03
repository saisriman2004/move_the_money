import 'dotenv/config';

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

function parseLogLevel(value: string | undefined): LogLevel {
  const level = value ?? 'info';
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`Invalid LOG_LEVEL: ${value} (expected one of ${LOG_LEVELS.join(', ')})`);
  }
  return level as LogLevel;
}

function parseJwtSecret(value: string | undefined): string {
  if (!value || value.length < 32) {
    throw new Error('JWT_SECRET must be set to at least 32 characters');
  }
  return value;
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

/** A percentage such as "1" or "0.25", from 0 to 100, kept as a string for exact SQL math. */
function parseFeePercent(value: string | undefined): string {
  const percent = value ?? '0';
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(percent) || Number(percent) > 100) {
    throw new Error(`Invalid TRANSFER_FEE_PERCENT: ${value}`);
  }
  return percent;
}

/** Comma-separated milliseconds, e.g. "1000,5000,25000". */
function parseDelays(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const delays = raw.split(',').map((d) => Number(d.trim()));
  if (delays.length === 0 || delays.some((d) => !Number.isInteger(d) || d <= 0)) throw new Error(`Invalid ${name}: ${raw}`);
  return delays;
}

function parseAmountSetting(name: string, fallback: string): string {
  const raw = process.env[name] ?? fallback;
  if (!/^\d{1,18}(\.\d{1,2})?$/.test(raw)) throw new Error(`Invalid ${name}: ${raw}`);
  return raw;
}

/** "false" (default), "true", or a number of proxy hops in front of the app. */
function parseTrustProxy(value: string | undefined): boolean | number {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0) throw new Error(`Invalid TRUST_PROXY: ${value}`);
  return hops;
}

export const config = {
  port: parsePort(process.env.PORT),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: required('DATABASE_URL'),
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
  // Set LOG_FILE=off to log to the console only.
  logFile: process.env.LOG_FILE ?? 'logs/app.log',
  // Browser origins allowed to call the API cross-origin, e.g. "https://app.example.com".
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  // Behind a load balancer, trust X-Forwarded-For so req.ip (used by the per-IP rate limit) is the client's.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // If set, GET /metrics requires "Authorization: Bearer <token>".
  metricsToken: process.env.METRICS_TOKEN || undefined,
  // Port for a worker's /metrics and /health. Each worker has its own default.
  workerMetricsPort: (fallback: number) => parsePositiveInt('WORKER_METRICS_PORT', fallback),
  // Read on first use, so tools that never issue tokens (like the migration runner)
  // don't need the secret. The server checks it at startup in index.ts.
  get jwtSecret(): string {
    return parseJwtSecret(process.env.JWT_SECRET);
  },
  // Access tokens are short-lived; there is no refresh token yet.
  jwtTtlSeconds: parsePositiveInt('JWT_TTL_SECONDS', 3600),
  // Charged to the sender on top of the amount, rounded to the cent. 0 disables fees.
  transferFeePercent: parseFeePercent(process.env.TRANSFER_FEE_PERCENT),
  rabbitmqUrl: process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672',
  // Prefixes every exchange and queue name, so environments (or test runs) sharing a broker don't collide.
  amqpPrefix: process.env.AMQP_PREFIX ?? 'mtm.',
  // A failed message is retried after each delay in turn, then dead-lettered.
  consumerRetryDelaysMs: parseDelays('CONSUMER_RETRY_DELAYS_MS', [1000, 5000, 25000]),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  redisPrefix: process.env.REDIS_PREFIX ?? 'mtm:',
  // Requests per window for each logged-in user, and for each IP on login/register.
  rateLimitPerWindow: parsePositiveInt('RATE_LIMIT_PER_MINUTE', 100),
  authRateLimitPerWindow: parsePositiveInt('AUTH_RATE_LIMIT_PER_MINUTE', 10),
  rateLimitWindowMs: parsePositiveInt('RATE_LIMIT_WINDOW_MS', 60_000),
  accountCacheTtlSeconds: parsePositiveInt('ACCOUNT_CACHE_TTL_SECONDS', 30),
  webhooks: {
    timeoutMs: parsePositiveInt('WEBHOOK_TIMEOUT_MS', 5000),
    maxAttempts: parsePositiveInt('WEBHOOK_MAX_ATTEMPTS', 8),
    // Delay before retry n is base * 2^(n-1): 10s, 20s, 40s, ... about 21 minutes in total.
    retryBaseMs: parsePositiveInt('WEBHOOK_RETRY_BASE_MS', 10_000),
    // Off by default: stops endpoints pointing at internal addresses (SSRF). Enable for local development.
    allowPrivateUrls: process.env.WEBHOOK_ALLOW_PRIVATE_URLS === 'true',
    maxEndpointsPerUser: 10,
  },
  reconciliationIntervalMs: parsePositiveInt('RECONCILIATION_INTERVAL_MS', 3_600_000),
  risk: {
    reviewAmount: parseAmountSetting('RISK_REVIEW_AMOUNT', '1000.00'),
    rejectAmount: parseAmountSetting('RISK_REJECT_AMOUNT', '10000.00'),
    maxTransfersPerMinute: parsePositiveInt('RISK_MAX_TRANSFERS_PER_MINUTE', 10),
    newAccountHours: parsePositiveInt('RISK_NEW_ACCOUNT_HOURS', 24),
    newAccountReviewAmount: parseAmountSetting('RISK_NEW_ACCOUNT_REVIEW_AMOUNT', '500.00'),
    maxRecentRejections: parsePositiveInt('RISK_MAX_RECENT_REJECTIONS', 3),
  },
};
