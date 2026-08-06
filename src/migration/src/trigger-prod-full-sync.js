#!/usr/bin/env node
// Trigger the Go onboarding pipeline (full sync -> calibration -> compute) once
// for every real production user. Safe by default: --commit is required.

import { parseArgs } from "node:util";

import { users as REAL_USERS } from "./users.js";

function usage() {
  process.stdout.write(`trigger-prod-full-sync — start full syncs through the Go API

Usage: node src/trigger-prod-full-sync.js [options]

  --commit          Send production requests. Default is dry-run.
  --run-key <key>   Stable batch key used for idempotency. Required with --commit.
                    Reuse the same key when retrying an interrupted invocation.
  --api-url <url>   Go API origin. Default: STRIDE_GO_API_URL.
  --poll-seconds <n> Poll interval from 5 to 10 seconds. Default: 5.
  --max-wait-minutes <n> Stop waiting after this many minutes. Default: 360.
  --help            Show this help.

Required environment for --commit:
  STRIDE_GO_API_URL          Production Go API origin (unless --api-url is used).
  STRIDE_GO_INTERNAL_TOKEN   Go API X-Internal-Token value.
`);
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      commit: { type: "boolean", default: false },
      "run-key": { type: "string" },
      "api-url": { type: "string" },
      "poll-seconds": { type: "string", default: "5" },
      "max-wait-minutes": { type: "string", default: "360" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  return {
    commit: values.commit,
    runKey: values["run-key"]?.trim(),
    apiUrl: values["api-url"] || process.env.STRIDE_GO_API_URL,
    pollSeconds: Number(values["poll-seconds"]),
    maxWaitMinutes: Number(values["max-wait-minutes"]),
    help: values.help,
  };
}

function validateProductionUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("Go API URL must use https");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Go API URL must not contain credentials, a query, or a fragment");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

async function trigger(apiUrl, token, user, runKey) {
  const response = await fetch(new URL("/pipelines", apiUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `prod-full-sync:${runKey}:${user}`,
      "X-Internal-Token": token,
    },
    body: JSON.stringify({
      name: "onboarding",
      user_id: user,
      input: { mode: "full", content: "all", limit: 0 },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${response.status}: response was not JSON`);
  }
  if (![200, 202].includes(response.status) || typeof body?.run_id !== "string") {
    throw new Error(`trigger returned HTTP ${response.status}`);
  }
  return body;
}

async function getState(apiUrl, token, path) {
  const response = await fetch(new URL(path, apiUrl), {
    headers: { "X-Internal-Token": token },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || !body) {
    throw new Error(`GET ${path} returned HTTP ${response.status}`);
  }
  return body;
}

function jobSummary(job) {
  const detail = [`${job.status}`, `${job.progress_pct}%`];
  if (job.stage) detail.push(`stage=${job.stage}`);
  if (job.attempts) detail.push(`attempts=${job.attempts}`);
  if (job.error_code) detail.push(`error_code=${job.error_code}`);
  return detail.join(" ");
}

async function pollRun(apiUrl, token, run) {
  const pipeline = await getState(apiUrl, token, `/pipelines/${run.runId}`);
  const steps = await Promise.all(
    pipeline.steps.map(async (step) => {
      if (!step.job_id) return `${step.name}=${step.status}`;
      try {
        const job = await getState(apiUrl, token, `/jobs/${step.job_id}`);
        return `${step.name}=${jobSummary(job)}`;
      } catch {
        return `${step.name}=${step.status} job_status=unavailable`;
      }
    }),
  );
  console.log(`status user=${run.user} pipeline=${pipeline.status} ${steps.join(" | ")}`);
  return pipeline;
}

async function waitForRuns(apiUrl, token, runs, pollSeconds, maxWaitMinutes) {
  const pending = new Map(runs.map((run) => [run.runId, run]));
  const pollFailures = new Map();
  const deadline = Date.now() + maxWaitMinutes * 60_000;
  let failed = 0;
  while (pending.size > 0) {
    const results = await Promise.allSettled(
      [...pending.values()].map(async (run) => {
        try {
          return { run, pipeline: await pollRun(apiUrl, token, run) };
        } catch (error) {
          error.runId = run.runId;
          throw error;
        }
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        const runId = result.reason.runId;
        const attempts = (pollFailures.get(runId) || 0) + 1;
        pollFailures.set(runId, attempts);
        console.error(`poll failed run_id=${runId} attempt=${attempts}/12`);
        if (attempts >= 12) {
          pending.delete(runId);
          failed += 1;
        }
        continue;
      }
      const { run, pipeline } = result.value;
      pollFailures.delete(run.runId);
      if (pipeline.status === "done" || pipeline.status === "failed") {
        pending.delete(run.runId);
        if (pipeline.status === "failed") failed += 1;
      }
    }
    if (pending.size > 0) {
      if (Date.now() >= deadline) {
        console.error(`timed out waiting for ${pending.size} pipeline(s)`);
        failed += pending.size;
        break;
      }
      console.log(`waiting: pending=${pending.size}; polling again in ${pollSeconds}s`);
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
    }
  }
  return failed;
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    usage();
    return 0;
  }

  console.log(`mode=${opts.commit ? "COMMIT" : "dry-run"} users=${REAL_USERS.length}`);
  if (!opts.commit) {
    console.log("No requests sent. Pass --commit and --run-key <key> to execute.");
    return 0;
  }
  if (!opts.runKey || !/^[A-Za-z0-9._-]{1,80}$/.test(opts.runKey)) {
    throw new Error("--run-key is required and must contain 1-80 letters, digits, '.', '_' or '-'");
  }
  if (!Number.isInteger(opts.pollSeconds) || opts.pollSeconds < 5 || opts.pollSeconds > 10) {
    throw new Error("--poll-seconds must be an integer from 5 to 10");
  }
  if (!Number.isInteger(opts.maxWaitMinutes) || opts.maxWaitMinutes < 1) {
    throw new Error("--max-wait-minutes must be a positive integer");
  }
  if (!opts.apiUrl) throw new Error("--api-url or STRIDE_GO_API_URL is required");
  const token = process.env.STRIDE_GO_INTERNAL_TOKEN;
  if (!token) throw new Error("STRIDE_GO_INTERNAL_TOKEN is required");
  const apiUrl = validateProductionUrl(opts.apiUrl);

  let failures = 0;
  const runs = [];
  for (const user of REAL_USERS) {
    try {
      const result = await trigger(apiUrl, token, user, opts.runKey);
      const action = result.deduplicated ? "existing" : "started";
      console.log(`${action} user=${user} run_id=${result.run_id}`);
      runs.push({ user, runId: result.run_id });
    } catch (error) {
      failures += 1;
      console.error(`failed user=${user}: ${error.message}`);
    }
  }

  if (runs.length > 0) {
    console.log(`polling ${runs.length} pipeline(s) every ${opts.pollSeconds}s until completion`);
    failures += await waitForRuns(
      apiUrl,
      token,
      runs,
      opts.pollSeconds,
      opts.maxWaitMinutes,
    );
  }
  console.log(`summary: completed=${REAL_USERS.length - failures} failed=${failures}`);
  return failures ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
