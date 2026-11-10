import assert from "node:assert/strict";
import test from "node:test";
import { AdjustmentEventClosedError, GoWeeklyPlanClient } from "../../src/goClient/weeklyPlanClient.js";
import { asPermanent } from "../../src/job/errors.js";

/**
 * Go 周课内部通道客户端单测（#858）：请求形状（x-internal-token、路径、body）
 * + 错误分级（4xx=permanent、401/5xx=瞬态可重试）。镜像 jobClient.test.ts。
 */

function client(handler: (request: Request) => Promise<Response>) {
  const fetchImpl = async (input: unknown, init?: unknown): Promise<Response> => handler(new Request(input as URL, init as RequestInit | undefined));
  return new GoWeeklyPlanClient("http://go.test", "secret-token", fetchImpl as unknown as typeof fetch);
}

/** 捕获请求的持有者（闭包内赋值，避开 TS 控制流收窄到 null）。 */
function capture(): { current?: Request } {
  return {};
}

const APPLIED = { results: [{ week_start: "2026-08-17", plan_id: "p1", revision: 2, replaced: true }] };

test("batch-apply 打内部端点、带头与 body，解析逐周结果", async () => {
  const seen = capture();
  const go = client(async (request) => {
    seen.current = request;
    return new Response(JSON.stringify(APPLIED), { status: 201 });
  });
  const applied = await go.batchApplyWeeklyPlans("u-1", "master-1", [{ week_name: "2026-08-17_08-23" }]);
  assert.deepEqual(applied, [{ week_start: "2026-08-17", plan_id: "p1", revision: 2, replaced: true }]);
  const request = seen.current!;
  assert.equal(request.method, "POST");
  assert.equal(new URL(request.url).pathname, "/api/internal/users/u-1/plan/weeks/batch-apply");
  assert.equal(request.headers.get("x-internal-token"), "secret-token");
  const body = JSON.parse(await request.clone().text()) as { master_plan_id: string; weeks: unknown[] };
  assert.equal(body.master_plan_id, "master-1");
  assert.equal(body.weeks.length, 1);
});

test("list 打查询串并解析周行", async () => {
  const seen = capture();
  const go = client(async (request) => {
    seen.current = request;
    return new Response(JSON.stringify({ weeks: [{ week_start: "2026-08-17", master_plan_id: "master-1", revision: 1 }] }), { status: 200 });
  });
  const weeks = await go.listWeeklyPlanWeeks("u-1", "master 1?");
  assert.deepEqual(weeks, [{ week_start: "2026-08-17", master_plan_id: "master-1", revision: 1 }]);
  const url = new URL(seen.current!.url);
  assert.equal(url.pathname, "/api/internal/users/u-1/plan/weeks");
  assert.equal(url.searchParams.get("master_plan_id"), "master 1?");
});

test("batch-apply 409（异 master plan 周冲突）= permanent", async () => {
  const go = client(async () => new Response('{"error":"weekly_plan_master_plan_conflict"}', { status: 409 }));
  await assert.rejects(go.batchApplyWeeklyPlans("u-1", "m", []), (error: unknown) => {
    const permanent = asPermanent(error);
    assert.ok(permanent);
    assert.equal(permanent.code, "weekly_plan_apply_rejected");
    assert.match(permanent.message, /409/);
    return true;
  });
});

test("422 校验失败 = permanent；401/500 = 瞬态（非 PermanentError）", async () => {
  const rejected = client(async () => new Response('{"error":"invalid_content"}', { status: 422 }));
  await assert.rejects(rejected.batchApplyWeeklyPlans("u-1", "m", []), (error: unknown) => asPermanent(error) !== null);

  for (const status of [401, 500]) {
    const flaky = client(async () => new Response("boom", { status }));
    await assert.rejects(flaky.batchApplyWeeklyPlans("u-1", "m", []), (error: unknown) => {
      assert.equal(asPermanent(error), null, `status ${status} must stay retryable`);
      return true;
    });
  }
});

// ── upsertAdjustment（#858 PR-C 夜检建行通道）─────────────────────────────────

test("upsertAdjustment 打 POST /plan-adjustments、body 形状正确、解析行", async () => {
  const seen = capture();
  const go = client(async (request) => {
    seen.current = request;
    return new Response(
      JSON.stringify({
        adjustment: {
          id: "adj-9",
          master_plan_id: "m-1",
          event_week_start: "2026-08-17",
          reason: "no_time",
          status: "pending",
          payload: "{}",
          question: "问句",
        },
      }),
      { status: 201 },
    );
  });
  const row = await go.upsertAdjustment("u-1", {
    masterPlanId: "m-1",
    eventWeekStart: "2026-08-17",
    reason: "no_time",
    question: "上周完成得不理想，主要是？",
    payload: '{"v":1}',
  });
  assert.equal(row.id, "adj-9");
  assert.equal(row.status, "pending");
  const request = seen.current!;
  assert.equal(request.method, "POST");
  assert.equal(new URL(request.url).pathname, "/api/internal/users/u-1/plan-adjustments");
  const body = JSON.parse(await request.clone().text()) as Record<string, string>;
  assert.deepEqual(Object.keys(body).sort(), ["event_week_start", "master_plan_id", "payload", "question", "reason"]);
  assert.equal(body.question, "上周完成得不理想，主要是？");
});

test("upsertAdjustment 409 事件已关闭 = AdjustmentEventClosedError；其他 4xx = permanent", async () => {
  const closed = client(async () => new Response('{"error":"adjustment_event_closed"}', { status: 409 }));
  await assert.rejects(
    closed.upsertAdjustment("u-1", { masterPlanId: "m", eventWeekStart: "2026-08-17", reason: "no_time", question: "q", payload: "{}" }),
    (error: unknown) => error instanceof AdjustmentEventClosedError,
  );

  const rejected = client(async () => new Response('{"error":"invalid_event"}', { status: 400 }));
  await assert.rejects(
    rejected.upsertAdjustment("u-1", { masterPlanId: "m", eventWeekStart: "bad", reason: "no_time", question: "q", payload: "{}" }),
    (error: unknown) => asPermanent(error) !== null,
  );
});
