import assert from "node:assert/strict";
import test from "node:test";
import { loadEvalWorkerConfig } from "../../src/eval/config.js";

const base = {
  PLAN_WORKER_AMQP_URL: "amqp://guest:guest@rabbitmq:5672/",
  PLAN_WORKER_EVAL_QUEUE: "plan.eval.execute.2026.11.30",
  PLAN_WORKER_EVAL_AGENT_VERSION: "2026.11.30",
  PLAN_WORKER_EVAL_API_BASE_URL: "http://plan-eval-api:8080/",
  PLAN_WORKER_EVAL_API_TOKEN: "worker-secret",
};

test("eval config comes entirely from the environment and fails fast when a dependency is missing", () => {
  const config = loadEvalWorkerConfig(base);
  assert.equal(config.queue, "plan.eval.execute.2026.11.30");
  assert.equal(config.agentVersion, "2026.11.30");
  assert.deepEqual(config.api, { baseUrl: "http://plan-eval-api:8080/", token: "worker-secret" });
  assert.deepEqual(config.consumer, { prefetch: 1 });
  assert.equal(config.lease.renewIntervalMs, 20_000);
  for (const missing of Object.keys(base)) {
    const env = { ...base, [missing]: "" };
    assert.throws(() => loadEvalWorkerConfig(env), `missing ${missing}`);
  }
  assert.throws(() => loadEvalWorkerConfig({ ...base, PLAN_WORKER_CONSUMER_PREFETCH: "0" }));
});
