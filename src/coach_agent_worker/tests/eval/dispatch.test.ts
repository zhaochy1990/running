import assert from "node:assert/strict";
import test from "node:test";
import { type EvalApiClient, type EvalLease, MissingExecutionError, StaleLeaseError } from "../../src/eval/client.js";
import { EvalDispatcher } from "../../src/eval/dispatch.js";
import type { ClaimResponse, ExecutionInput, GenerateReceipt, GenerateResult } from "../../src/eval/protocol.js";
import { EXECUTION_ID, input, leased, receipt } from "./fixtures.js";

const executionMessage = () => ({ schema_version: 1 as const, snapshot_execution_id: EXECUTION_ID });

type Script = Partial<Pick<EvalApiClient, "claim" | "renew" | "submit">>;

/** 续租间隔取 5ms：测试不等待真实计时器。 */
function build(script: Script, generate: (input: ExecutionInput, signal: { lost: boolean }) => Promise<GenerateResult>, clock = { now: 0 }) {
  const calls: string[] = [];
  const client = {
    claim: async (id: string, version: string, worker: string, claimRequestId: string) => {
      calls.push(`claim:${id}:${version}:${worker}`);
      return script.claim ? script.claim(id, version, worker, claimRequestId) : leased();
    },
    renew: async (id: string, lease: EvalLease) => {
      calls.push(`renew:${id}:${lease.lease_epoch}`);
      return script.renew ? script.renew(id, lease) : undefined;
    },
    submit: async (id: string, lease: EvalLease, result: GenerateResult, submitId: string) => {
      calls.push(`submit:${id}:${lease.lease_epoch}:${result.kind}`);
      return script.submit ? script.submit(id, lease, result, submitId) : receipt;
    },
  } as unknown as EvalApiClient;
  const dispatcher = new EvalDispatcher({
    client,
    agentVersion: "2026.11.30",
    workerId: "worker-1",
    generate,
    lease: { renewIntervalMs: 5, busyMaxWaitMs: 1_000 },
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
  });
  return { dispatcher, calls };
}

const artifact: GenerateResult = { kind: "artifact", artifact_type: "master_plan", content: "{}" };
const generateOk = async (): Promise<GenerateResult> => artifact;

test("leased → generate → submit: resolves only after the persisted receipt", async () => {
  const { dispatcher, calls } = build({}, generateOk);
  await dispatcher.process(executionMessage());
  assert.deepEqual(calls, [`claim:${EXECUTION_ID}:2026.11.30:worker-1`, `submit:${EXECUTION_ID}:1:artifact`]);
});

test("an execution that is already settled (or unknown) is acknowledged without generating again", async () => {
  for (const settled of [{ status: "terminal", generate_status: "done", artifact_id: "a" }, { status: "missing" }] as unknown as ClaimResponse[]) {
    let generated = 0;
    const { dispatcher, calls } = build({ claim: async () => settled }, async () => {
      generated++;
      return artifact;
    });
    await dispatcher.process(executionMessage());
    assert.equal(generated, 0);
    assert.equal(calls.length, 1);
  }
});

test("a valid lease held elsewhere keeps the message unacknowledged and retries with bounded backoff", async () => {
  const answers: ClaimResponse[] = [{ status: "busy", retry_after_ms: 400 }, { status: "busy", retry_after_ms: 5_000 }, leased(4)];
  const { dispatcher, calls } = build({ claim: async () => answers.shift() ?? leased() }, generateOk, { now: 0 });
  await dispatcher.process(executionMessage());
  // 第二次退避被剩余预算截到 600ms（上限 1000ms）。
  assert.deepEqual(calls, [
    `claim:${EXECUTION_ID}:2026.11.30:worker-1`,
    `claim:${EXECUTION_ID}:2026.11.30:worker-1`,
    `claim:${EXECUTION_ID}:2026.11.30:worker-1`,
    `submit:${EXECUTION_ID}:4:artifact`,
  ]);
  const clock = { now: 0 };
  const stuck = build({ claim: async () => ({ status: "busy", retry_after_ms: 300 }) as ClaimResponse }, generateOk, clock);
  await assert.rejects(stuck.dispatcher.process(executionMessage()), /stayed busy for 1000ms/);
  assert.ok(clock.now >= 1_000);
});

test("a stale lease must redeliver, but a vanished execution can be acknowledged", async () => {
  const { dispatcher: stale } = build({ submit: async () => Promise.reject(new StaleLeaseError(EXECUTION_ID, "submit")) }, generateOk);
  await assert.rejects(stale.process(executionMessage()), StaleLeaseError);
  const { dispatcher: missing } = build({ submit: async () => Promise.reject(new MissingExecutionError(EXECUTION_ID)) }, generateOk);
  await missing.process(executionMessage());
});

test("an infrastructure fault while submitting rejects, so the broker redelivers", async () => {
  const { dispatcher } = build({ submit: async () => Promise.reject(new TypeError("fetch failed")) }, generateOk);
  await assert.rejects(dispatcher.process(executionMessage()), /fetch failed/);
  const { dispatcher: unreachable } = build({ claim: async () => Promise.reject(new TypeError("fetch failed")) }, generateOk);
  await assert.rejects(unreachable.process(executionMessage()), /fetch failed/);
});

test("losing the lease mid-generation discards the result instead of submitting it", async () => {
  const { dispatcher, calls } = build(
    { renew: async () => Promise.reject(new StaleLeaseError(EXECUTION_ID, "renew")) },
    async (_input, signal) =>
      new Promise((resolve) => {
        const poll = () => (signal.lost ? resolve(artifact) : setTimeout(poll, 5));
        poll();
      }),
  );
  await assert.rejects(dispatcher.process(executionMessage()), StaleLeaseError);
  assert.deepEqual(calls, [`claim:${EXECUTION_ID}:2026.11.30:worker-1`, `renew:${EXECUTION_ID}:1`]);
});

test("a transient renew failure does not lose the lease", async () => {
  let attempts = 0;
  const { dispatcher, calls } = build(
    {
      renew: async () => (attempts++ === 0 ? Promise.reject(new TypeError("econnreset")) : Promise.resolve()),
      submit: async () => ({ ...receipt, evaluate_status: "done" }) as GenerateReceipt,
    },
    async () => artifact,
  );
  await dispatcher.process(executionMessage());
  assert.equal(calls.at(-1), `submit:${EXECUTION_ID}:1:artifact`);
});

test("input flows from the claim into generate untouched", async () => {
  const seen: ExecutionInput[] = [];
  await build({}, async (claimed) => {
    seen.push(claimed);
    return artifact;
  }).dispatcher.process(executionMessage());
  assert.deepEqual(seen, [input]);
});

test("claim retries retain their request ID and zero busy hints cannot spin", async () => {
  const requestIds: string[] = [];
  const identities: EvalLease[] = [];
  const clock = { now: 0 };
  const { dispatcher } = build(
    {
      claim: async (_id, _version, _worker, requestId) => {
        requestIds.push(requestId);
        return requestIds.length === 1 ? { status: "busy", retry_after_ms: 0 } : leased();
      },
      submit: async (_id, identity, _result, submitId) => {
        identities.push(identity);
        assert.ok(submitId.length > 0);
        return receipt;
      },
    },
    generateOk,
    clock,
  );
  await dispatcher.process(executionMessage());
  assert.equal(clock.now, 1);
  assert.equal(requestIds[0], requestIds[1]);
  assert.deepEqual(identities, [{ agent_version: "2026.11.30", worker_id: "worker-1", lease_epoch: 1 }]);
});
