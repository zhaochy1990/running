/**
 * Structured logging for STRIDE Node services, backed by pino.
 *
 * A single root logger is configured once (level, redaction, dev pretty-print);
 * every module takes a namespaced child via {@link getLogger}, mirroring the
 * Python `logging.getLogger(__name__)` pattern. Child loggers carry a `name`
 * field so JSON logs stay filterable per module.
 *
 * Level resolution (first match wins):
 *   1. `STRIDE_COACH_LOG_LEVEL` / `LOG_LEVEL` — explicit pino level.
 *   2. `STRIDE_COACH_DEBUG` truthy → `debug`.
 *   3. otherwise `info` (so `debug` traces stay quiet, `warn`/`error` show).
 *
 * Output: pretty (via `pino-pretty`) on an interactive TTY in non-production;
 * newline-delimited JSON otherwise. Force JSON with `STRIDE_COACH_LOG_JSON=1`.
 */

import pino from "pino";

export type Logger = pino.Logger;

const KNOWN_LEVELS: ReadonlySet<string> = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

function resolveLevel(): string {
  const explicit = process.env.STRIDE_COACH_LOG_LEVEL ?? process.env.LOG_LEVEL;
  if (explicit) {
    const level = explicit.toLowerCase();
    if (KNOWN_LEVELS.has(level)) {
      return level;
    }
  }
  if (process.env.STRIDE_COACH_DEBUG === "1" || process.env.STRIDE_COACH_DEBUG === "true") {
    return "debug";
  }
  return "info";
}

function isProduction(): boolean {
  return (process.env.STRIDE_COACH_ENV ?? process.env.NODE_ENV) === "production";
}

function usePretty(): boolean {
  if (process.env.STRIDE_COACH_LOG_JSON === "1") {
    return false;
  }
  return !isProduction() && Boolean(process.stdout.isTTY);
}

// Never let secrets or model I/O reach the logs (AGENTS.md HARD rule: prompts /
// responses / tokens must not be persisted to logs). Redaction is applied to
// these keys wherever they appear one or two levels deep in a log object.
const REDACT_PATHS: string[] = [
  "apiKey",
  "api_key",
  "apikey",
  "token",
  "accessToken",
  "access_token",
  "authorization",
  "Authorization",
  "password",
  "secret",
  "prompt",
  "response",
  "messages",
  "*.apiKey",
  "*.api_key",
  "*.token",
  "*.authorization",
  "*.password",
  "*.secret",
];

function buildRootLogger(): Logger {
  const options: pino.LoggerOptions = {
    level: resolveLevel(),
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  };
  if (usePretty()) {
    options.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    };
  }
  return pino(options);
}

/** The process-wide root logger. Prefer {@link getLogger} for module traces. */
export const rootLogger: Logger = buildRootLogger();

/** A namespaced child logger, e.g. `getLogger("resolver")`. */
export function getLogger(name: string): Logger {
  return rootLogger.child({ name });
}
