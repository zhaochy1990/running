/**
 * #867 staff whitelist + funnel dashboard route tests.
 *
 * Same harness style as lottery.test.ts: fake stores + the real createApp
 * with a stub verifier, exercising the auth layering (admin double gate for
 * the dashboard/staff surfaces, public + optionally-attributed ping) and the
 * funnel merge of event counts with participation people counts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { AuthError, type JwtVerifier } from "../src/auth.js";
import type { LotteryActivityRow, LotteryPrizeRow, LotteryStore } from "../src/persistence/lottery.js";
import type { LotteryEventInput, LotteryEventStage, LotteryFunnelSceneRow, LotteryFunnelStore } from "../src/persistence/lotteryFunnel.js";
import type { LotteryStaffInput, LotteryStaffRow, LotteryStaffStore } from "../src/persistence/lotteryStaff.js";
import { parseStaffRequest } from "../src/routes/lotteryStaff.js";

const neverStream = () => {
  throw new Error("must not stream");
};

/** 无/坏 Bearer 抛 AuthError（与真实 verifier 同形）。 */
const verifierFor = (isAdmin: boolean): JwtVerifier => ({
  async verify(authorization) {
    if (typeof authorization !== "string" || !authorization.toLowerCase().startsWith("bearer ")) {
      throw new AuthError("missing bearer token");
    }
    return { userId: isAdmin ? "admin-1" : "athlete-1", isAdmin };
  },
});

class FakeStaffStore implements LotteryStaffStore {
  nextId = 1;
  readonly rows = new Map<number, LotteryStaffRow>();

  async setup(): Promise<void> {}

  async listStaff(activityId?: number): Promise<LotteryStaffRow[]> {
    const rows = [...this.rows.values()];
    const filtered = activityId === undefined ? rows : rows.filter((row) => row.activityId === null || row.activityId === activityId);
    return filtered.sort((a, b) => (a.activityId ?? 0) - (b.activityId ?? 0) || a.openid.localeCompare(b.openid));
  }

  async addStaff(input: LotteryStaffInput): Promise<LotteryStaffRow> {
    const row: LotteryStaffRow = {
      id: this.nextId++,
      openid: input.openid,
      activityId: input.activityId ?? null,
      note: input.note ?? null,
      createdAt: new Date("2026-11-03T10:00:00Z"),
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async removeStaff(id: number): Promise<boolean> {
    return this.rows.delete(id);
  }
}

class FakeFunnelStore implements LotteryFunnelStore {
  readonly events: LotteryEventInput[] = [];
  /** 预置的漏斗分组结果（按 scene 分组的参与人数侧）。 */
  scenes: LotteryFunnelSceneRow[] = [];

  async setup(): Promise<void> {}

  async recordEvent(input: LotteryEventInput): Promise<void> {
    this.events.push(input);
  }

  async funnelByScene(): Promise<LotteryFunnelSceneRow[]> {
    return this.scenes.map((row) => ({ ...row }));
  }
}

/** 只实现 funnel 路由用到的两个读法的最小 LotteryStore 假件。 */
class FakeActivityReader {
  readonly activities = new Map<number, LotteryActivityRow>();
  prizes: LotteryPrizeRow[] = [];

  async getActivity(id: number): Promise<LotteryActivityRow | null> {
    return this.activities.get(id) ?? null;
  }

  async listPrizes(): Promise<LotteryPrizeRow[]> {
    return this.prizes;
  }
}

function dashboardApp(options: { adminVerifier?: boolean; staff?: FakeStaffStore; funnel?: FakeFunnelStore } = {}) {
  const staff = options.staff ?? new FakeStaffStore();
  const funnel = options.funnel ?? new FakeFunnelStore();
  const store = new FakeActivityReader();
  const app = createApp({
    jwtVerifier: verifierFor(options.adminVerifier ?? true),
    coachInvoker: { async invoke() { throw new Error("must not invoke"); }, streamEvents: neverStream },
    lottery: store as unknown as LotteryStore,
    lotteryStaff: staff,
    lotteryFunnel: funnel,
  });
  return { app, staff, funnel, store };
}

const AUTH = { authorization: "Bearer signed", "content-type": "application/json" };

function activity(store: FakeActivityReader, id: number): LotteryActivityRow {
  const row: LotteryActivityRow = {
    id,
    name: `活动 ${id}`,
    startAt: new Date("2026-12-01T10:00:00+08:00"),
    endAt: new Date("2026-12-02T10:00:00+08:00"),
    enabled: true,
    rulesText: null,
    heroImage: null,
    createdAt: new Date("2026-11-01T08:00:00Z"),
    updatedAt: new Date("2026-11-01T08:00:00Z"),
  };
  store.activities.set(id, row);
  return row;
}

// ── 纯函数：staff 请求体解析 ────────────────────────────────────────

test("parseStaffRequest：合法体、边界与非法输入", () => {
  assert.deepEqual(parseStaffRequest({ openid: "oX-123" }), { ok: true, value: { openid: "oX-123" } });
  assert.deepEqual(parseStaffRequest({ openid: "oX-123", activity_id: 7, note: "现场 A" }), {
    ok: true,
    value: { openid: "oX-123", activityId: 7, note: "现场 A" },
  });
  // 空串 note 视为未填。
  const blankNote = parseStaffRequest({ openid: "oX-123", note: "" });
  assert.ok(blankNote.ok && blankNote.value.note === undefined);

  assert.equal(parseStaffRequest(null).ok, false);
  assert.equal(parseStaffRequest({}).ok, false);
  assert.equal(parseStaffRequest({ openid: "  " }).ok, false);
  assert.equal(parseStaffRequest({ openid: 42 }).ok, false);
  assert.equal(parseStaffRequest({ openid: "oX-123", activity_id: 0 }).ok, false);
  assert.equal(parseStaffRequest({ openid: "oX-123", activity_id: "7" }).ok, false);
  assert.equal(parseStaffRequest({ openid: "oX-123", note: 5 }).ok, false);
});

// ── staff 白名单 CRUD 路由 ─────────────────────────────────────────

test("staff：增删查全链路；非 admin 403、未登录 401", async () => {
  const { app, staff } = dashboardApp();

  const created = await app.request("/api/admin/lottery/staff", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ openid: "oStaff-1", activity_id: 3, note: "东门易拉宝" }),
  });
  assert.equal(created.status, 201);
  const row = (await created.json()) as Record<string, unknown>;
  assert.equal(row.openid, "oStaff-1");
  assert.equal(row.activity_id, 3);

  // 全局行（不带 activity_id）。
  const global = await app.request("/api/admin/lottery/staff", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ openid: "oBoss" }),
  });
  assert.equal(global.status, 201);
  assert.equal(((await global.json()) as Record<string, unknown>).activity_id, null);

  const list = await app.request("/api/admin/lottery/staff", { headers: AUTH });
  assert.equal(list.status, 200);
  assert.equal(((await list.json()) as { staff: unknown[] }).staff.length, 2);

  // activity_id 过滤：活动行 + 全局行。
  const scoped = await app.request("/api/admin/lottery/staff?activity_id=3", { headers: AUTH });
  assert.equal(((await scoped.json()) as { staff: unknown[] }).staff.length, 2);
  const other = await app.request("/api/admin/lottery/staff?activity_id=9", { headers: AUTH });
  assert.equal(((await other.json()) as { staff: unknown[] }).staff.length, 1);

  // 删除。
  const removed = await app.request(`/api/admin/lottery/staff/${row.id}`, { method: "DELETE", headers: AUTH });
  assert.equal(removed.status, 204);
  const removeAgain = await app.request(`/api/admin/lottery/staff/${row.id}`, { method: "DELETE", headers: AUTH });
  assert.equal(removeAgain.status, 404);
  assert.equal(staff.rows.size, 1);

  // 鉴权分层。
  const anon = await app.request("/api/admin/lottery/staff");
  assert.equal(anon.status, 401);
  const user = dashboardApp({ adminVerifier: false });
  const userList = await user.app.request("/api/admin/lottery/staff", { headers: AUTH });
  assert.equal(userList.status, 403);

  // 结构校验。
  const bad = await app.request("/api/admin/lottery/staff", { method: "POST", headers: AUTH, body: JSON.stringify({ note: "无 openid" }) });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: string }).error, "invalid_openid");
});

// ── 漏斗看板端点 ───────────────────────────────────────────────────

test("funnel：admin 读漏斗（点位分组 + 汇总 + 库存余量）；非 admin 403", async () => {
  const { app, funnel, store } = dashboardApp();
  activity(store, 3);
  funnel.scenes = [
    { scene: "01", enter: 120, login: 80, bind: 60, draw: 55, win: 12, verified: 10 },
    { scene: "02", enter: 40, login: 30, bind: 25, draw: 20, win: 4, verified: 4 },
    { scene: null, enter: 5, login: 5, bind: 5, draw: 5, win: 1, verified: 1 },
  ];

  const ok = await app.request("/api/admin/lottery/activities/3/funnel", { headers: AUTH });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as {
    activity: { id: number };
    scenes: { scene: string | null }[];
    totals: { enter: number; login: number; bind: number; draw: number; win: number; verified: number };
    prizes: unknown[];
  };
  assert.equal(body.activity.id, 3);
  assert.equal(body.scenes.length, 3);
  assert.deepEqual(body.totals, { enter: 165, login: 115, bind: 90, draw: 80, win: 17, verified: 15 });

  const missing = await app.request("/api/admin/lottery/activities/999/funnel", { headers: AUTH });
  assert.equal(missing.status, 404);
  const malformed = await app.request("/api/admin/lottery/activities/abc/funnel", { headers: AUTH });
  assert.equal(malformed.status, 400);

  const user = dashboardApp({ adminVerifier: false, funnel });
  const userFunnel = await user.app.request("/api/admin/lottery/activities/3/funnel", { headers: AUTH });
  assert.equal(userFunnel.status, 403);
});

// ── 公开埋点 ping ──────────────────────────────────────────────────

test("events：公开 ping 三阶段；可选归因；非法 stage/scene 400；活动不存在 404", async () => {
  const { app, funnel, store } = dashboardApp();
  activity(store, 3);

  for (const stage of ["enter", "login", "bind"] as LotteryEventStage[]) {
    const ping = await app.request("/api/lottery/activities/3/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage, scene: "01" }),
    });
    assert.equal(ping.status, 204);
  }
  assert.deepEqual(funnel.events, [
    { activityId: 3, stage: "enter", scene: "01", userId: null },
    { activityId: 3, stage: "login", scene: "01", userId: null },
    { activityId: 3, stage: "bind", scene: "01", userId: null },
  ]);

  // 带 token → 归因（optionalAuth 不拒绝匿名）。
  await app.request("/api/lottery/activities/3/events", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ stage: "login", scene: "02" }),
  });
  assert.equal(funnel.events[3]?.userId, "admin-1");

  // scene 可缺省（直链）。
  await app.request("/api/lottery/activities/3/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "enter" }),
  });
  assert.equal(funnel.events[4]?.scene, null);

  // 非法输入。
  const badStage = await app.request("/api/lottery/activities/3/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "draw" }),
  });
  assert.equal(badStage.status, 400);
  assert.equal(((await badStage.json()) as { error: string }).error, "invalid_stage");
  const badScene = await app.request("/api/lottery/activities/3/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "enter", scene: "带 空格" }),
  });
  assert.equal(badScene.status, 400);
  assert.equal(((await badScene.json()) as { error: string }).error, "invalid_scene");

  const unknownActivity = await app.request("/api/lottery/activities/77/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "enter" }),
  });
  assert.equal(unknownActivity.status, 404);
});

test("events：同 IP+活动固定窗口限速（429），跨活动独立计数", async () => {
  const { app, store } = dashboardApp();
  activity(store, 3);
  activity(store, 4);

  const ping = (id: number, stage: string = "enter") =>
    app.request(`/api/lottery/activities/${id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ stage }),
    });

  let last = 204;
  for (let i = 0; i < 60; i++) {
    last = (await ping(3)).status;
    assert.equal(last, 204);
  }
  // 第 61 次：同活动被限。
  assert.equal((await ping(3)).status, 429);
  // 另一活动不受影响。
  assert.equal((await ping(4)).status, 204);
});
