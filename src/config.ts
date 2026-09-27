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

export const config = {
  port: parsePort(process.env.PORT),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: required('DATABASE_URL'),
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
  // Set LOG_FILE=off to log to the console only.
  logFile: process.env.LOG_FILE ?? 'logs/app.log',
};
