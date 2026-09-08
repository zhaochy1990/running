import assert from "node:assert/strict";
import test from "node:test";
import type { PlanJob, PlanJobType } from "@stride/coach-agent-worker";
import { createApp } from "../src/app.js";
import { AuthError } from "../src/auth.js";
import type { PlanJobsService } from "../src/routes/planJobs.js";

const REQUEST = {
  request_id: "req-1",
  requested_mode: "new_season",
  requested_modifiers: [],
  goals: [{ race_name: "西安马拉松", distance: "FM", race_date: "2026-10-18", target_time: "2:50:00", finish_only: false, priority: "A" }],
  availability: {
    weekly_run_days_max: 6,
    available_training_windows: [],
    unavailable_days: [],
    max_session_duration_min: 180,
    allows_double_sessions: true,
    preferred_long_run_day: "saturday",
    strength_sessions_per_week: 2,
    strength_available_days: ["monday", "thursday"],
  },
  injury_declarations: [],
  environment_constraints: [],
  travel_constraints: [],
  preferences: [],
  prohibited_arrangements: [],
  active_plan_action: "none",
  user_confirmations: {
    intake_complete: true,
    goals_confirmed: true,
    availability_confirmed: true,
    injury_history_confirmed: true,
    constraints_confirmed: true,
  },
};

interface EnqueueCall {
  userId: string;
  jobType: PlanJobType;
  inputJson: string;
  idempotencyKey?: string;
}

function fakePlanJobs(overrides: Partial<PlanJobsService> = {}): { service: PlanJobsService; enqueued: EnqueueCall[] } {
  const enqueued: EnqueueCall[] = [];
  const store = new Map<string, PlanJob>();
  const service: PlanJobsService = {
    async enqueue(input) {
      enqueued.push({ ...input });
      const job: PlanJob = {
        jobId: "job-1",
        userId: input.userId,
        jobType: input.jobType,
        status: "queued",
        attempts: 0,
        stage: "",
        progressPct: 0,
        inputJson: input.inputJson,
        resultJson: null,
        errorCode: null,
        errorMessage: null,
        idempotencyKey: input.idempotencyKey ?? null,
        heartbeatAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      };
      store.set(job.jobId, job);
      return { jobId: job.jobId, estimatedDurationSeconds: 300 };
    },
    async get(userId, jobId) {
      const job = store.get(jobId);
      return job !== undefined && job.userId === userId ? job : null;
    },
    ...overrides,
  };
  return { service, enqueued };
}

function appFor(planJobs: PlanJobsService) {
  return createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: {
      async invoke() {
        throw new Error("must not invoke coach");
      },
    },
    planJobs,
  });
}

test("enqueue re-validates the kernel request server-side and returns job_id + estimate", async () => {
  const { service, enqueued } = fakePlanJobs();
  const app = appFor(service);
  const response = await app.request("/api/users/me/coach/plan-jobs", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify({ job_type: "generate_master_plan", request: REQUEST, idempotency_key: "key-1" }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    job_id: "job-1",
    job_type: "generate_master_plan",
    estimated_duration_seconds: 300,
  });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.userId, "athlete-1");
  assert.equal(enqueued[0]?.jobType, "generate_master_plan");
  assert.equal(enqueued[0]?.idempotencyKey, "key-1");
  // The persisted input is the parsed (re-validated) request.
  assert.deepEqual(JSON.parse(enqueued[0]!.inputJson), REQUEST);
});

test("an invalid kernel request is rejected without touching the enqueuer", async () => {
  const { service, enqueued } = fakePlanJobs();
  const app = appFor(service);
  const response = await app.request("/api/users/me/coach/plan-jobs", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify({ job_type: "generate_master_plan", request: { request_id: "broken" } }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_request" });
  assert.equal(enqueued.length, 0);
});

test("an unknown job_type is rejected", async () => {
  const { service, enqueued } = fakePlanJobs();
  const app = appFor(service);
  const response = await app.request("/api/users/me/coach/plan-jobs", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify({ job_type: "nope", request: REQUEST }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_job_type" });
  assert.equal(enqueued.length, 0);
});

test("a valid but not-yet-wired job_type is rejected, not enqueued", async () => {
  const { service, enqueued } = fakePlanJobs();
  const app = appFor(service);
  const response = await app.request("/api/users/me/coach/plan-jobs", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify({ job_type: "generate_weekly_plan", request: REQUEST }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "unsupported_job_type" });
  assert.equal(enqueued.length, 0);
});

test("enqueue requires a bearer token", async () => {
  const { service } = fakePlanJobs();
  const app = createApp({
    jwtVerifier: {
      async verify() {
        throw new AuthError("missing token");
      },
    },
    coachInvoker: {
      async invoke() {
        throw new Error("must not invoke coach");
      },
    },
    planJobs: service,
  });
  const response = await app.request("/api/users/me/coach/plan-jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ job_type: "generate_master_plan", request: REQUEST }),
  });
  assert.equal(response.status, 401);
});

test("poll returns status, stage, progress, error code and, when done, the draft id", async () => {
  const job: PlanJob = {
    jobId: "job-9",
    userId: "athlete-1",
    jobType: "generate_master_plan",
    status: "done",
    attempts: 1,
    stage: "outputting",
    progressPct: 100,
    inputJson: "{}",
    resultJson: JSON.stringify({ draft_id: "draft-9", revision: 1 }),
    errorCode: null,
    errorMessage: null,
    idempotencyKey: null,
    heartbeatAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: new Date(),
  };
  const { service } = fakePlanJobs({
    async get(userId, jobId) {
      return jobId === "job-9" && userId === "athlete-1" ? job : null;
    },
  });
  const app = appFor(service);
  const response = await app.request("/api/users/me/coach/plan-jobs/job-9", { headers: { authorization: "Bearer x" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    job_id: "job-9",
    job_type: "generate_master_plan",
    status: "done",
    stage: "outputting",
    progress_pct: 100,
    error_code: null,
    result_draft_id: "draft-9",
  });
});

test("poll of a failed job surfaces the stable error code and no draft", async () => {
  const job: PlanJob = {
    jobId: "job-f",
    userId: "athlete-1",
    jobType: "generate_master_plan",
    status: "failed",
    attempts: 1,
    stage: "planning_phases",
    progressPct: 60,
    inputJson: "{}",
    resultJson: null,
    errorCode: "kernel_goal_conflict",
    errorMessage: "goal conflict",
    idempotencyKey: null,
    heartbeatAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: new Date(),
  };
  const { service } = fakePlanJobs({ async get() { return job; } });
  const app = appFor(service);
  const response = await app.request("/api/users/me/coach/plan-jobs/job-f", { headers: { authorization: "Bearer x" } });
  assert.deepEqual(await response.json(), {
    job_id: "job-f",
    job_type: "generate_master_plan",
    status: "failed",
    stage: "planning_phases",
    progress_pct: 60,
    error_code: "kernel_goal_conflict",
    result_draft_id: null,
  });
});

test("poll of an unknown or foreign job is a 404", async () => {
  const { service } = fakePlanJobs();
  const app = appFor(service);
  const missing = await app.request("/api/users/me/coach/plan-jobs/nope", { headers: { authorization: "Bearer x" } });
  assert.equal(missing.status, 404);
  const invalid = await app.request("/api/users/me/coach/plan-jobs/invalid id!", { headers: { authorization: "Bearer x" } });
  assert.equal(invalid.status, 400);
});

test("plan-job routes are absent when no planJobs service is wired", async () => {
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "u" }; } },
    coachInvoker: { async invoke() { throw new Error("unused"); } },
  });
  const response = await app.request("/api/users/me/coach/plan-jobs/job-1", { headers: { authorization: "Bearer x" } });
  assert.equal(response.status, 404);
});