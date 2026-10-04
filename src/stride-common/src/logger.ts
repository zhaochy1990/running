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
 *
 * The root writes through a tee so a debug log file can be attached later via
 * {@link attachFileLogging} (local only): every line keeps going to stdout and
 * is additionally pretty-printed into the file. Redaction applies before the
 * tee, so the file obeys the same secret/model-I/O rules as stdout.
 */

import { Writable } from "node:stream";
import pino from "pino";
import pretty from "pino-pretty";
import { resolveEnvironment } from "./config.js";

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

function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.STRIDE_COACH_ENV ?? env.NODE_ENV) === "production";
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

const PRETTY_OPTIONS = {
  translateTime: "SYS:HH:MM:ss.l",
  ignore: "pid,hostname",
} as const;

/** File leg of the tee; `null` until {@link attachFileLogging} attaches one. */
let fileLeg: NodeJS.WritableStream | null = null;

function buildTeeDestination(): NodeJS.WritableStream {
  // pino-pretty defaults its own destination to stdout.
  const stdoutLeg: NodeJS.WritableStream = usePretty() ? pretty({ ...PRETTY_OPTIONS, colorize: true }) : process.stdout;
  return new Writable({
    write(chunk, _encoding, callback) {
      stdoutLeg.write(chunk);
      fileLeg?.write(chunk);
      callback();
    },
  });
}

function buildRootLogger(): Logger {
  const options: pino.LoggerOptions = {
    level: resolveLevel(),
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  };
  return pino(options, buildTeeDestination());
}

/** The process-wide root logger. Prefer {@link getLogger} for module traces. */
export const rootLogger: Logger = buildRootLogger();

/** A namespaced child logger, e.g. `getLogger("resolver")`. */
export function getLogger(name: string): Logger {
  return rootLogger.child({ name });
}

export interface AttachFileLoggingOptions {
  /** Overrides `process.env` for the local-only guard (used by tests). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Tee pretty-text copies of every log line into `path` (created, with parent
 * directories). Local-only: outside the `local` environment the call logs a
 * warning and does nothing, so file logging can never silently run in
 * dev/staging/prod. Attach once at startup; repeated calls keep the first
 * stream. An unopenable path logs a warning instead of throwing, and runtime
 * file-leg errors disable the leg — stdout logging is never lost.
 *
 * @returns whether the file leg is (or already was) attached.
 */
export function attachFileLogging(path: string, options: AttachFileLoggingOptions = {}): boolean {
  if (!path) {
    return false;
  }
  const environment = resolveEnvironment(options);
  if (environment !== "local" || isProduction(options.env ?? process.env)) {
    rootLogger.warn({ environment, file: path }, "file logging is local-only; ignoring logging.file");
    return false;
  }
  if (fileLeg) {
    return true;
  }
  // sonic-boom opens the file synchronously, so an unopenable path (EISDIR,
  // EACCES, ...) throws here rather than emitting an async "error" later.
  let destination: ReturnType<typeof pino.destination>;
  let stream: ReturnType<typeof pretty>;
  try {
    destination = pino.destination({ dest: path, mkdir: true, sync: true });
    stream = pretty({ ...PRETTY_OPTIONS, colorize: false, destination });
  } catch (error) {
    rootLogger.warn({ error, file: path }, "cannot open log file; continuing on stdout only");
    return false;
  }
  const detach = (error: unknown): void => {
    if (fileLeg === stream) {
      fileLeg = null;
    }
    rootLogger.error({ error, file: path }, "file logging failed; continuing on stdout only");
  };
  destination.once("error", detach);
  stream.once("error", detach);
  fileLeg = stream;
  rootLogger.info({ file: path }, "file logging attached");
  return true;
}
