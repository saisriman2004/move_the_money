import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { config, type LogLevel } from './config';

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: Infinity };

let file: WriteStream | undefined;
if (config.logFile !== 'off' && config.logLevel !== 'silent') {
  mkdirSync(path.dirname(config.logFile), { recursive: true });
  file = createWriteStream(config.logFile, { flags: 'a' });
}

/**
 * Writes one JSON object per line to the console and to LOG_FILE, so the file
 * can be searched with grep or parsed line by line.
 */
function write(level: Exclude<LogLevel, 'silent'>, msg: string, fields: Record<string, unknown> = {}): void {
  if (SEVERITY[level] < SEVERITY[config.logLevel]) return;
  const line = `${JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })}\n`;
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);
  file?.write(line);
}

/** Turns an Error into plain fields; JSON.stringify would otherwise drop the message and stack. */
export function errorFields(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  const { code, constraint } = err as { code?: string; constraint?: string };
  return { error: err.message, stack: err.stack, pg_code: code, pg_constraint: constraint };
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};
