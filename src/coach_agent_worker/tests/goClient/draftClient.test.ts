import assert from "node:assert/strict";
import test from "node:test";
import { GoDraftClient } from "../../src/goClient/draftClient.js";
import { asPermanent, ERROR_CODES } from "../../src/job/errors.js";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("inserts a master-plan draft with the internal token and returns the plan id", async () => {
  const captured: { url: string; init: RequestInit } = { url: "", init: {} };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.init = init ?? {};
    return new Response(JSON.stringify({ success: true, plan_id: "draft-abc", status: "draft" }), { status: 201 });
  }) as typeof fetch;

  const client = new GoDraftClient("http://go-api:8080", "secret-token", fetchImpl);
  const planId = await client.insertMasterPlanDraft("user-1", "draft-abc", { goal: { goal_id: "g" } });

  assert.equal(planId, "draft-abc");
  assert.equal(captured.url, "http://go-api:8080/api/users/user-1/master-plan/drafts");
  const headers = (captured.init.headers ?? {}) as Record<string, string>;
  assert.equal(headers["x-internal-token"], "secret-token");
  const body = JSON.parse(String(captured.init.body)) as { draft_id: string; content: unknown };
  assert.equal(body.draft_id, "draft-abc");
  assert.deepEqual(body.content, { goal: { goal_id: "g" } });
});

test("an idempotent 200 replay returns the existing plan id", async () => {
  const client = new GoDraftClient("http://go-api", "t", fakeFetch(200, { success: true, plan_id: "draft-abc", status: "draft" }));
  assert.equal(await client.insertMasterPlanDraft("user-1", "draft-abc", {}), "draft-abc");
});

test("rejected content is a permanent error with a stable code", async () => {
  const client = new GoDraftClient("http://go-api", "t", fakeFetch(422, { error: "invalid_content" }));
  await assert.rejects(client.insertMasterPlanDraft("user-1", "draft-abc", {}), (error: unknown) => {
    const permanent = asPermanent(error);
    assert.ok(permanent);
    assert.equal(permanent.code, ERROR_CODES.DRAFT_REJECTED);
    return true;
  });
});

test("a transient 5xx is a retryable error, not permanent", async () => {
  const client = new GoDraftClient("http://go-api", "t", fakeFetch(500, { error: "boom" }));
  await assert.rejects(client.insertMasterPlanDraft("user-1", "draft-abc", {}), (error: unknown) => {
    assert.equal(asPermanent(error), null);
    return true;
  });
});

test("a missing plan_id in a 201 body surfaces as an error", async () => {
  const client = new GoDraftClient("http://go-api", "t", fakeFetch(201, { success: true }));
  await assert.rejects(client.insertMasterPlanDraft("user-1", "draft-abc", {}), /no plan_id/);
});

test("inserts a weekly-plan draft at the week-scoped path and returns the plan id", async () => {
  const captured: { url: string; init: RequestInit } = { url: "", init: {} };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.init = init ?? {};
    return new Response(JSON.stringify({ success: true, plan_id: "draft-abc", week_name: "2026-08-17_08-23", status: "draft" }), { status: 201 });
  }) as typeof fetch;

  const client = new GoDraftClient("http://go-api:8080", "secret-token", fetchImpl);
  const planId = await client.insertWeeklyPlanDraft("user-1", "2026-08-17_08-23", "draft-abc", { schema: "weekly-plan/v1" });

  assert.equal(planId, "draft-abc");
  assert.equal(captured.url, "http://go-api:8080/api/user-1/plan/weeks/2026-08-17_08-23/drafts");
  const headers = (captured.init.headers ?? {}) as Record<string, string>;
  assert.equal(headers["x-internal-token"], "secret-token");
  const body = JSON.parse(String(captured.init.body)) as { draft_id: string; content: unknown };
  assert.equal(body.draft_id, "draft-abc");
  assert.deepEqual(body.content, { schema: "weekly-plan/v1" });
});

test("an idempotent 200 weekly replay returns the existing plan id", async () => {
  const client = new GoDraftClient("http://go-api", "t", fakeFetch(200, { success: true, plan_id: "draft-abc", status: "draft" }));
  assert.equal(await client.insertWeeklyPlanDraft("user-1", "2026-08-17_08-23", "draft-abc", {}), "draft-abc");
});

test("rejected weekly content is a permanent error with a stable code", async () => {
  const client = new GoDraftClient("http://go-api", "t", fakeFetch(422, { error: "invalid_content" }));
  await assert.rejects(client.insertWeeklyPlanDraft("user-1", "2026-08-17_08-23", "draft-abc", {}), (error: unknown) => {
    assert.equal(asPermanent(error)?.code, ERROR_CODES.DRAFT_REJECTED);
    return true;
  });
});

test("a transient 5xx weekly insert is a retryable error, not permanent", async () => {
  const client = new GoDraftClient("http://go-api", "t", fakeFetch(500, { error: "boom" }));
  await assert.rejects(client.insertWeeklyPlanDraft("user-1", "2026-08-17_08-23", "draft-abc", {}), (error: unknown) => {
    assert.equal(asPermanent(error), null);
    return true;
  });
});
