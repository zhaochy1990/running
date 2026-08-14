#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { users as REAL_USERS } from "./users.js";

const GO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "go");

export function goBackfillArgs(argv) {
  return ["run", "./cmd/stride", "backfill-activity-start-gps", ...argv];
}

export function goBackfillEnv(env) {
  return {
    ...env,
    STRIDE_ACTIVITY_START_GPS_REAL_USERS: REAL_USERS.join(","),
  };
}

export function main(argv = process.argv.slice(2)) {
  const child = spawn("go", goBackfillArgs(argv), {
    cwd: GO_DIR,
    env: goBackfillEnv(process.env),
    stdio: "inherit",
  });
  child.on("error", (error) => {
    process.stderr.write(`fatal: unable to start Go backfill: ${error.message}\n`);
    process.exitCode = 2;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 2 : (code ?? 2);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
