/*
 * CamoCrawl — original rendering-service module.
 * Part of CamoCrawl (Firecrawl + Camoufox backend), licensed under the
 * GNU Affero General Public License v3.0 or later; see root LICENSE.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Do not remove this header or any upstream copyright/license notices.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const isLogLevel = (value: string): value is LogLevel =>
  (Object.keys(LEVEL_WEIGHT) as string[]).includes(value);

const MAX_VALUE_LENGTH = 512;

const serialize = (value: unknown): unknown => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack.split('\n').slice(0, 6).join('\n') } : {}),
    };
  }
  if (typeof value === 'string' && value.length > MAX_VALUE_LENGTH) {
    return `${value.slice(0, MAX_VALUE_LENGTH)}… (${value.length} chars)`;
  }
  return value;
};

/**
 * Minimal leveled logger. Emits one line per record so the output stays
 * greppable in `docker compose logs` without pulling in a logging framework.
 */
export class Logger {
  constructor(
    private readonly scope: string,
    private readonly threshold: number,
  ) {}

  child(scope: string): Logger {
    return new Logger(`${this.scope}.${scope}`, this.threshold);
  }

  isEnabled(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= this.threshold;
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }

  private write(
    level: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    if (LEVEL_WEIGHT[level] < this.threshold) return;

    const parts = [
      new Date().toISOString(),
      level.toUpperCase().padEnd(5),
      `[${this.scope}]`,
      message,
    ];

    if (fields && Object.keys(fields).length > 0) {
      const serialized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        serialized[key] = serialize(value);
      }
      if (Object.keys(serialized).length > 0) {
        parts.push(JSON.stringify(serialized));
      }
    }

    const line = parts.join(' ');
    // Warnings and errors go to stderr so they are not lost when stdout is a
    // pipe that is only drained on stdout.
    if (level === 'error' || level === 'warn') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
}

export const createLogger = (level: LogLevel, scope = 'playwright'): Logger =>
  new Logger(scope, LEVEL_WEIGHT[level]);