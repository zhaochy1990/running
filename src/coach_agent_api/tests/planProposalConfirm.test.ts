import assert from "node:assert/strict";
import test from "node:test";
import type { PlanJob, PlanJobType } from "@stride/coach-agent-worker";
import { createApp } from "../src/app.js";
import { AuthError } from "../src/auth.js";
import type { PlanJobsService } from "../src/routes/planJobs.js";
import { createInMemoryTurnCoordinator } from "../src/turn/index.js";

/** streamEvents / invoke stubs for tests that must never run the coach. */
const neverStream = () => {
  throw new Error("must not stream");
};

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

interface AppendedCall {
  threadId: string;
  content: unknown;
}

function buildDeps(overrides: { planJobs?: Partial<PlanJobsService> } = {}) {
  const enqueued: EnqueueCall[] = [];
  const appended: AppendedCall[] = [];
  let jobCounter = 0;

  const planJobs: PlanJobsService = {
    async enqueue(input) {
      enqueued.push({ ...input });
      jobCounter += 1;
      return { jobId: `job-${jobCounter}`, estimatedDurationSeconds: 300 };
    },
    async get() {
      return null;
    },
    ...overrides.planJobs,
  };

  const coachInvoker = {
    async invoke() {
      throw new Error("must not invoke");
    },
    streamEvents: neverStream,
    async appendThreadMessage(threadId: string, message: unknown) {
      appended.push({ threadId, content: message });
    },
  };

  const turnCoordinator = createInMemoryTurnCoordinator();
  return { planJobs, coachInvoker, turnCoordinator, enqueued, appended };
}

function appFor(deps: ReturnType<typeof buildDeps>) {
  return createApp({
    jwtVerifier: {
      async verify() {
        return { userId: "athlete-1" };
      },
    },
    coachInvoker: deps.coachInvoker,
    turnCoordinator: deps.turnCoordinator,
    planJobs: deps.planJobs,
  });
}

const CONFIRM_BODY = {
  session_id: "session-1",
  client_turn_id: "confirm-1",
  job_type: "generate_master_plan",
  request: REQUEST,
};

test("confirm re-validates the request, enqueues, and appends a confirmation message to the thread", async () => {
  const deps = buildDeps();
  const app = appFor(deps);
  const response = await app.request("/api/users/me/coach/plan-proposals/confirm", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify(CONFIRM_BODY),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { job_id: "job-1", job_type: "generate_master_plan" });

  assert.equal(deps.enqueued.length, 1);
  assert.equal(deps.enqueued[0]?.userId, "athlete-1");
  assert.equal(deps.enqueued[0]?.jobType, "generate_master_plan");
  assert.equal(deps.enqueued[0]?.idempotencyKey, "confirm-1");
  assert.deepEqual(JSON.parse(deps.enqueued[0]!.inputJson), REQUEST);

  assert.equal(deps.appended.length, 1);
  assert.equal(deps.appended[0]?.threadId, "athlete-1:coach:session-1");
  const message = deps.appended[0]?.content as { content?: unknown };
  const parsed = JSON.parse(String(message?.content ?? "{}")) as Record<string, unknown>;
  assert.equal(parsed.kind, "plan_job_confirmed");
  assert.equal(parsed.job_id, "job-1");
  assert.equal(parsed.job_type, "generate_master_plan");
});

test("replaying the same confirm turn is idempotent (no double enqueue / append)", async () => {
  const deps = buildDeps();
  const app = appFor(deps);
  const body = JSON.stringify(CONFIRM_BODY);
  const first = await app.request("/api/users/me/coach/plan-proposals/confirm", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body,
  });
  const second = await app.request("/api/users/me/coach/plan-proposals/confirm", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body,
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(await second.json(), { job_id: "job-1", job_type: "generate_master_plan" });
  assert.equal(deps.enqueued.length, 1);
  assert.equal(deps.appended.length, 1);
});

test("an invalid kernel request is rejected without enqueueing", async () => {
  const deps = buildDeps();
  const app = appFor(deps);
  const response = await app.request("/api/users/me/coach/plan-proposals/confirm", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify({ ...CONFIRM_BODY, request: { request_id: "broken" } }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_request" });
  assert.equal(deps.enqueued.length, 0);
  assert.equal(deps.appended.length, 0);
});

test("an unwired job_type is rejected", async () => {
  const deps = buildDeps();
  const app = appFor(deps);
  const response = await app.request("/api/users/me/coach/plan-proposals/confirm", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify({ ...CONFIRM_BODY, job_type: "generate_weekly_plan" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_job_type" });
  assert.equal(deps.enqueued.length, 0);
});

test("confirm requires a bearer token", async () => {
  const deps = buildDeps();
  const app = createApp({
    jwtVerifier: {
      async verify() {
        throw new AuthError("missing token");
      },
    },
    coachInvoker: deps.coachInvoker,
    turnCoordinator: deps.turnCoordinator,
    planJobs: deps.planJobs,
  });
  const response = await app.request("/api/users/me/coach/plan-proposals/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(CONFIRM_BODY),
  });
  assert.equal(response.status, 401);
});

test("confirm route is absent when no planJobs service is wired", async () => {
  const app = createApp({
    jwtVerifier: { async verify() { return { userId: "u" }; } },
    coachInvoker: {
      async invoke() {
        throw new Error("unused");
      },
      streamEvents: neverStream,
      async appendThreadMessage() {
        throw new Error("unused");
      },
    },
  });
  const response = await app.request("/api/users/me/coach/plan-proposals/confirm", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify(CONFIRM_BODY),
  });
  assert.equal(response.status, 404);
});
