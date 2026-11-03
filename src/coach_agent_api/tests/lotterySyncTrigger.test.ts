import assert from "node:assert/strict";
import test from "node:test";
import { createLotterySyncTrigger } from "../src/coach/lotterySyncTrigger.js";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/** 顺序回放的假 fetch：guard 查询 → POST 触发。 */
function fakeFetch(script: { ok: boolean; status: number; body?: unknown; throw?: Error }[]) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    const step = script[requests.length - 1];
    if (step === undefined) throw new Error("unexpected extra fetch");
    if (step.throw) throw step.throw;
    return {
      ok: step.ok,
      status: step.status,
      json: async () => step.body,
    } as Response;
  }) as typeof fetch;
  return { requests, fetchImpl };
}

const GO_API = { baseUrl: "http://go:8080", internalToken: "secret-token" };

function ok(body: unknown) {
  return { ok: true, status: 200, body };
}

test("新用户：guard 无历史 run → POST /sync 带 internal token、幂等键与 mode:full", async () => {
  const { requests, fetchImpl } = fakeFetch([ok({ pipelines: [] }), { ok: true, status: 202, body: { run_id: "r1" } }]);
  await createLotterySyncTrigger(GO_API, fetchImpl).triggerFullSyncIfNewUser(5, "11111111-1111-1111-1111-111111111111");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "http://go:8080/api/users/11111111-1111-1111-1111-111111111111/pipelines");
  assert.deepEqual(requests[0]?.init.headers, { "x-internal-token": "secret-token" });

  assert.equal(requests[1]?.url, "http://go:8080/api/11111111-1111-1111-1111-111111111111/sync");
  assert.equal(requests[1]?.init.method, "POST");
  assert.deepEqual(requests[1]?.init.headers, {
    "content-type": "application/json",
    "x-internal-token": "secret-token",
    "idempotency-key": "lottery-sync-5-11111111-1111-1111-1111-111111111111",
  });
  assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), { mode: "full" });
});

test("存量用户 guard：已有 pipeline run → 跳过触发（不发 POST）", async () => {
  const { requests, fetchImpl } = fakeFetch([ok({ pipelines: [{ run_id: "old" }, { run_id: "older" }] })]);
  await createLotterySyncTrigger(GO_API, fetchImpl).triggerFullSyncIfNewUser(5, "user-1");
  assert.equal(requests.length, 1);
});

test("幂等键去重语义：POST 返回 200（重复键回既有 run）不视为失败", async () => {
  const { requests, fetchImpl } = fakeFetch([ok({ pipelines: [] }), { ok: true, status: 200, body: { run_id: "existing", deduplicated: true } }]);
  await createLotterySyncTrigger(GO_API, fetchImpl).triggerFullSyncIfNewUser(5, "user-1");
  assert.equal(requests.length, 2);
});

test("fail-soft：guard 非 2xx / 网络错误 / POST 非 2xx 都不抛错", async () => {
  // guard 500 → 不触发
  const guardError = fakeFetch([{ ok: false, status: 500 }]);
  await createLotterySyncTrigger(GO_API, guardError.fetchImpl).triggerFullSyncIfNewUser(5, "user-1");
  assert.equal(guardError.requests.length, 1);

  // guard 网络异常 → 不抛、不触发
  const networkError = fakeFetch([{ ok: false, status: 0, throw: new Error("ECONNREFUSED") }]);
  await createLotterySyncTrigger(GO_API, networkError.fetchImpl).triggerFullSyncIfNewUser(5, "user-1");
  assert.equal(networkError.requests.length, 1);

  // POST 500 → 不抛（抽奖结果不受影响，日志兜底）
  const postError = fakeFetch([ok({ pipelines: [] }), { ok: false, status: 500 }]);
  await createLotterySyncTrigger(GO_API, postError.fetchImpl).triggerFullSyncIfNewUser(5, "user-1");
  assert.equal(postError.requests.length, 2);

  // guard 返回体不是 JSON → 解析异常也不抛
  const badJson = fakeFetch([{ ok: true, status: 200, throw: new Error("invalid json") }]);
  await createLotterySyncTrigger(GO_API, badJson.fetchImpl).triggerFullSyncIfNewUser(5, "user-1");
  assert.equal(badJson.requests.length, 1);
});
