import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { AuthError, type JwtVerifier } from "../src/auth.js";
import type {
  LotteryActivityInput,
  LotteryActivityRow,
  LotteryPrizeInput,
  LotteryPrizeRow,
  LotteryStore,
} from "../src/persistence/lottery.js";
import { lotteryPhase, parseActivityRequest, parsePrizesRequest, prizeConfigError, timeWindowError } from "../src/routes/lottery.js";

/** streamEvents stub for tests that must never stream. */
const neverStream = () => {
  throw new Error("must not stream");
};

/** 仿真 verifier：无/坏 Bearer 头照真实JwtVerifier抛 AuthError，其余按预设身份放行。 */
const verifierFor = (isAdmin: boolean): JwtVerifier => ({
  async verify(authorization) {
    if (typeof authorization !== "string" || !authorization.toLowerCase().startsWith("bearer ")) {
      throw new AuthError("missing bearer token");
    }
    return { userId: isAdmin ? "admin-1" : "athlete-1", isAdmin };
  },
});

class FakeLotteryStore implements LotteryStore {
  nextId = 1;
  readonly activities = new Map<number, LotteryActivityRow>();
  prizesByActivity = new Map<number, LotteryPrizeRow[]>();
  participations = new Set<number>();

  async setup(): Promise<void> {}

  async createActivity(input: LotteryActivityInput): Promise<LotteryActivityRow> {
    const row: LotteryActivityRow = {
      id: this.nextId++,
      name: input.name,
      startAt: input.startAt,
      endAt: input.endAt,
      enabled: false,
      rulesText: input.rulesText ?? null,
      heroImage: input.heroImage ?? null,
      createdAt: new Date("2026-11-01T08:00:00Z"),
      updatedAt: new Date("2026-11-01T08:00:00Z"),
    };
    this.activities.set(row.id, row);
    return { ...row };
  }

  async updateActivity(id: number, input: LotteryActivityInput): Promise<LotteryActivityRow | null> {
    const existing = this.activities.get(id);
    if (existing === undefined) return null;
    const updated: LotteryActivityRow = {
      ...existing,
      name: input.name,
      startAt: input.startAt,
      endAt: input.endAt,
      rulesText: input.rulesText ?? null,
      heroImage: input.heroImage ?? null,
    };
    this.activities.set(id, updated);
    return { ...updated };
  }

  async setActivityEnabled(id: number, enabled: boolean): Promise<LotteryActivityRow | null> {
    const existing = this.activities.get(id);
    if (existing === undefined) return null;
    existing.enabled = enabled;
    return { ...existing };
  }

  async getActivity(id: number): Promise<LotteryActivityRow | null> {
    const row = this.activities.get(id);
    return row === undefined ? null : { ...row };
  }

  async listActivities(): Promise<LotteryActivityRow[]> {
    return [...this.activities.values()].map((row) => ({ ...row }));
  }

  async replacePrizes(activityId: number, prizes: LotteryPrizeInput[]): Promise<LotteryPrizeRow[]> {
    const rows = prizes.map((prize) => ({
      id: this.nextId++,
      activityId,
      name: prize.name,
      imageUrl: prize.imageUrl ?? null,
      stock: prize.stock,
      remaining: prize.stock,
      weight: prize.weight,
      isFallback: prize.isFallback,
    }));
    this.prizesByActivity.set(activityId, rows);
    return rows.map((row) => ({ ...row }));
  }

  async listPrizes(activityId: number): Promise<LotteryPrizeRow[]> {
    return (this.prizesByActivity.get(activityId) ?? []).map((row) => ({ ...row }));
  }

  async hasParticipations(activityId: number): Promise<boolean> {
    return this.participations.has(activityId);
  }
}

function lotteryApp(options: { store?: FakeLotteryStore; adminVerifier?: boolean } = {}) {
  const store = options.store ?? new FakeLotteryStore();
  return {
    store,
    app: createApp({
      jwtVerifier: verifierFor(options.adminVerifier ?? true),
      coachInvoker: {
        async invoke() {
          throw new Error("must not invoke");
        },
        streamEvents: neverStream,
      },
      lottery: store,
    }),
  };
}

const AUTH = { authorization: "Bearer signed", "content-type": "application/json" };

const WINDOW = {
  name: "上海站抽奖",
  start_at: "2026-12-01T10:00:00+08:00",
  end_at: "2026-12-02T10:00:00+08:00",
};

const VALID_POOL = {
  prizes: [
    { name: "一等奖 运动手表", image_url: "https://cos.example.com/p1.png", stock: 2, weight: 1, is_fallback: false },
    { name: "谢谢参与", stock: 0, weight: 5, is_fallback: true },
  ],
};

async function createActivity(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown> = WINDOW,
  headers: Record<string, string> = AUTH,
): Promise<Response> {
  return await app.request("/api/admin/lottery/activities", { method: "POST", headers, body: JSON.stringify(body) });
}

// ── 纯函数：时间窗状态 ────────────────────────────────────────────────

test("lotteryPhase：未开始/进行中/已结束（边界点归进行中）", () => {
  const start = new Date("2026-12-01T10:00:00+08:00");
  const end = new Date("2026-12-02T10:00:00+08:00");
  assert.equal(lotteryPhase(start, end, new Date("2026-11-30T00:00:00Z")), "not_started");
  assert.equal(lotteryPhase(start, end, start), "active");
  assert.equal(lotteryPhase(start, end, end), "active");
  assert.equal(lotteryPhase(start, end, new Date("2026-12-01T12:00:00Z")), "active");
  assert.equal(lotteryPhase(start, end, new Date("2026-12-02T02:00:01Z")), "ended");
});

// ── 纯函数：活动体解析 ───────────────────────────────────────────────

test("parseActivityRequest：合法体、无时区时间拒绝、非法字段报具体错误", () => {
  const ok = parseActivityRequest({ ...WINDOW, hero_image: "https://cos.example.com/hero.png" });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.name, "上海站抽奖");
    assert.equal(ok.value.startAt.toISOString(), "2026-12-01T02:00:00.000Z");
    assert.equal(ok.value.heroImage, "https://cos.example.com/hero.png");
  }

  assert.equal(parseActivityRequest({ name: "x", start_at: "2026-12-01 10:00:00", end_at: WINDOW.end_at }).ok, false);
  assert.equal(parseActivityRequest({ ...WINDOW, name: "" }).ok, false);
  assert.equal(parseActivityRequest({ ...WINDOW, hero_image: "http://cos.example.com/hero.png" }).ok, false);
  assert.equal(parseActivityRequest(null).ok, false);
});

test("timeWindowError：开始 ≥ 结束 → 422 口径文案", () => {
  const parsed = parseActivityRequest({ name: "x", start_at: "2026-12-02T10:00:00Z", end_at: "2026-12-01T10:00:00Z" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.match(timeWindowError(parsed.value) ?? "", /开始时间必须早于结束时间/);
});

// ── 纯函数：奖池解析 + 整池校验 ──────────────────────────────────────

test("parsePrizesRequest：weight 0 / 负库存 / 空数组 → 400 口径错误", () => {
  assert.equal(parsePrizesRequest(VALID_POOL).ok, true);
  assert.equal(parsePrizesRequest({ prizes: [{ ...VALID_POOL.prizes[0], weight: 0 }] }).ok, false);
  assert.equal(parsePrizesRequest({ prizes: [{ ...VALID_POOL.prizes[0], stock: -1 }] }).ok, false);
  assert.equal(parsePrizesRequest({ prizes: [] }).ok, false);
  assert.equal(parsePrizesRequest({}).ok, false);
});

test("prizeConfigError：必有且仅有一个兜底档、兜底不设库存、总库存 ≤ 999", () => {
  const prizesOrThrow = (body: unknown) => {
    const parsed = parsePrizesRequest(body);
    assert.ok(parsed.ok);
    return parsed.value;
  };

  const noFallback = { prizes: [{ name: "一等奖", stock: 1, weight: 1, is_fallback: false }] };
  assert.match(prizeConfigError(prizesOrThrow(noFallback)) ?? "", /仅有一个/);

  const twoFallbacks = {
    prizes: [
      { name: "谢谢参与A", stock: 0, weight: 1, is_fallback: true },
      { name: "谢谢参与B", stock: 0, weight: 1, is_fallback: true },
    ],
  };
  assert.match(prizeConfigError(prizesOrThrow(twoFallbacks)) ?? "", /仅有一个/);

  const fallbackWithStock = {
    prizes: [
      { name: "一等奖", stock: 1, weight: 1, is_fallback: false },
      { name: "谢谢参与", stock: 3, weight: 1, is_fallback: true },
    ],
  };
  assert.match(prizeConfigError(prizesOrThrow(fallbackWithStock)) ?? "", /兜底档不设库存/);

  const overStock = {
    prizes: [
      { name: "一等奖", stock: 500, weight: 1, is_fallback: false },
      { name: "二等奖", stock: 500, weight: 1, is_fallback: false },
      { name: "谢谢参与", stock: 0, weight: 1, is_fallback: true },
    ],
  };
  assert.match(prizeConfigError(prizesOrThrow(overStock)) ?? "", /999/);

  assert.equal(prizeConfigError(prizesOrThrow(VALID_POOL)), undefined);
});

// ── 路由：admin CRUD ─────────────────────────────────────────────────

test("admin 创建活动 → 201 默认停用；更新 → 200；时间窗倒挂 → 422", async () => {
  const { app } = lotteryApp();
  const created = await createActivity(app);
  assert.equal(created.status, 201);
  const body = (await created.json()) as Record<string, unknown>;
  assert.equal(body.enabled, false);
  assert.equal(body.status, "not_started");
  const id = body.id as number;

  const updated = await app.request(`/api/admin/lottery/activities/${id}`, {
    method: "PUT",
    headers: AUTH,
    body: JSON.stringify({ name: "上海站抽奖·改名", start_at: WINDOW.start_at, end_at: "2026-12-03T10:00:00+08:00", rules_text: "规则文案" }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = (await updated.json()) as Record<string, unknown>;
  assert.equal(updatedBody.name, "上海站抽奖·改名");
  assert.equal(updatedBody.rules_text, "规则文案");

  const inverted = await app.request(`/api/admin/lottery/activities/${id}`, {
    method: "PUT",
    headers: AUTH,
    body: JSON.stringify({ name: "x", start_at: "2026-12-02T10:00:00Z", end_at: "2026-12-01T10:00:00Z" }),
  });
  assert.equal(inverted.status, 422);
});

test("奖池整池替换：合法 200；缺兜底 / 总库存 1000 → 422；已有参与 → 409", async () => {
  const { app, store } = lotteryApp();
  const id = ((await (await createActivity(app)).json()) as { id: number }).id;

  const ok = await app.request(`/api/admin/lottery/activities/${id}/prizes`, {
    method: "PUT",
    headers: AUTH,
    body: JSON.stringify(VALID_POOL),
  });
  assert.equal(ok.status, 200);
  const prizes = ((await ok.json()) as { prizes: Record<string, unknown>[] }).prizes;
  assert.equal(prizes.length, 2);
  assert.equal(prizes[1]?.is_fallback, true);
  assert.equal(prizes[0]?.remaining, prizes[0]?.stock);

  const noFallback = await app.request(`/api/admin/lottery/activities/${id}/prizes`, {
    method: "PUT",
    headers: AUTH,
    body: JSON.stringify({ prizes: [{ name: "一等奖", stock: 1, weight: 1, is_fallback: false }] }),
  });
  assert.equal(noFallback.status, 422);

  const over = await app.request(`/api/admin/lottery/activities/${id}/prizes`, {
    method: "PUT",
    headers: AUTH,
    body: JSON.stringify({
      prizes: [
        { name: "一等奖", stock: 999, weight: 1, is_fallback: false },
        { name: "二等奖", stock: 1, weight: 1, is_fallback: false },
        { name: "谢谢参与", stock: 0, weight: 1, is_fallback: true },
      ],
    }),
  });
  assert.equal(over.status, 422);

  store.participations.add(id);
  const guarded = await app.request(`/api/admin/lottery/activities/${id}/prizes`, {
    method: "PUT",
    headers: AUTH,
    body: JSON.stringify(VALID_POOL),
  });
  assert.equal(guarded.status, 409);
});

test("启停：enable/disable 改变公开可见性；admin 详情带 prizes", async () => {
  const { app } = lotteryApp();
  const id = ((await (await createActivity(app)).json()) as { id: number }).id;
  await app.request(`/api/admin/lottery/activities/${id}/prizes`, { method: "PUT", headers: AUTH, body: JSON.stringify(VALID_POOL) });

  const enabled = await app.request(`/api/admin/lottery/activities/${id}/enable`, { method: "POST", headers: AUTH });
  assert.equal(enabled.status, 200);
  assert.equal(((await enabled.json()) as { enabled: boolean }).enabled, true);

  const detail = await app.request(`/api/admin/lottery/activities/${id}`, { headers: AUTH });
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as { prizes: { weight: number }[] };
  assert.equal(detailBody.prizes.length, 2);
  assert.equal(detailBody.prizes[0]?.weight, 1);

  const disabled = await app.request(`/api/admin/lottery/activities/${id}/disable`, { method: "POST", headers: AUTH });
  assert.equal(((await disabled.json()) as { enabled: boolean }).enabled, false);

  const afterDisable = await app.request(`/api/lottery/activities/${id}`);
  assert.equal(afterDisable.status, 404);
});

test("admin 列表：新建活动出现在列表", async () => {
  const { app } = lotteryApp();
  await createActivity(app, { ...WINDOW, name: "北京站" });
  const list = await app.request("/api/admin/lottery/activities", { headers: AUTH });
  assert.equal(list.status, 200);
  const body = (await list.json()) as { activities: { name: string }[] };
  assert.deepEqual(
    body.activities.map((a) => a.name),
    ["北京站"],
  );
});

// ── 路由：鉴权分层 ───────────────────────────────────────────────────

test("鉴权分层：公开读免登录 200；admin 写无 token → 401、普通用户 → 403、admin → 2xx", async () => {
  const adminApp = lotteryApp();
  const id = ((await (await createActivity(adminApp.app)).json()) as { id: number }).id;
  await adminApp.app.request(`/api/admin/lottery/activities/${id}/prizes`, {
    method: "PUT",
    headers: AUTH,
    body: JSON.stringify(VALID_POOL),
  });
  await adminApp.app.request(`/api/admin/lottery/activities/${id}/enable`, { method: "POST", headers: AUTH });

  // 免登录公开读：无 Authorization 头，200 且不含权重/配置库存。
  const publicRead = await adminApp.app.request(`/api/lottery/activities/${id}`);
  assert.equal(publicRead.status, 200);
  const body = (await publicRead.json()) as Record<string, unknown>;
  assert.equal(body.status, "not_started");
  for (const prize of body.prizes as Record<string, unknown>[]) {
    assert.equal("weight" in prize, false);
    assert.equal("stock" in prize, false);
    assert.equal("id" in prize, false);
  }
  const fallback = (body.prizes as Record<string, unknown>[]).find((prize) => prize.is_fallback === true);
  assert.equal(fallback?.remaining, null);

  // 写操作：无 token 401（公开路由可达、admin 路由挡在门外）。
  const anonymousWrite = await adminApp.app.request(`/api/admin/lottery/activities/${id}/enable`, { method: "POST" });
  assert.equal(anonymousWrite.status, 401);

  // 写操作：普通用户 token → 403（所有 admin 端点同门）。
  const userApp = lotteryApp({ adminVerifier: false, store: adminApp.store });
  for (const [method, path] of [
    ["POST", "/api/admin/lottery/activities"],
    ["GET", "/api/admin/lottery/activities"],
    ["GET", `/api/admin/lottery/activities/${id}`],
    ["PUT", `/api/admin/lottery/activities/${id}`],
    ["PUT", `/api/admin/lottery/activities/${id}/prizes`],
    ["POST", `/api/admin/lottery/activities/${id}/enable`],
    ["POST", `/api/admin/lottery/activities/${id}/disable`],
  ] as const) {
    const init: RequestInit = { method, headers: AUTH };
    if (method !== "GET") init.body = JSON.stringify(WINDOW);
    const response = await userApp.app.request(path, init);
    assert.equal(response.status, 403, `${method} ${path} 应为 403`);
  }

  // admin token 本身坏了（无 Bearer 头格式）→ 401。
  const badToken = await adminApp.app.request(`/api/admin/lottery/activities/${id}/enable`, { method: "POST", headers: { authorization: "nope" } });
  assert.equal(badToken.status, 401);
});

test("公开端点：未知 id / 非法 id / 已结束活动 → 404 / 404 / status=ended", async () => {
  const { app, store } = lotteryApp();

  const unknown = await app.request("/api/lottery/activities/999");
  assert.equal(unknown.status, 404);

  const malformed = await app.request("/api/lottery/activities/not-a-number");
  assert.equal(malformed.status, 404);

  // 已结束窗口：enabled + end 在过去 → 200 status=ended（历史活动仍可展示）。
  const ended = await store.createActivity({
    name: "已结束",
    startAt: new Date("2026-10-01T00:00:00Z"),
    endAt: new Date("2026-10-02T00:00:00Z"),
  });
  store.activities.get(ended.id)!.enabled = true;
  const read = await app.request(`/api/lottery/activities/${ended.id}`);
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as { status: string }).status, "ended");
});
