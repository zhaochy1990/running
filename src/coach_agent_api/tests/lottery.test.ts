import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { AuthError, type JwtVerifier } from "../src/auth.js";
import type { LotteryOpenidResolver, OpenidResolution } from "../src/coach/lotteryOpenid.js";
import type {
  DrawAllocation,
  LotteryActivityInput,
  LotteryActivityRow,
  LotteryParticipationRow,
  LotteryPrizeInput,
  LotteryPrizeRow,
  LotteryStore,
  LotteryVerificationLogInput,
  RedeemOutcome,
} from "../src/persistence/lottery.js";
import type { WatchCredentialReader } from "../src/persistence/watchCredentials.js";
import type { LotterySyncTrigger } from "../src/coach/lotterySyncTrigger.js";
import {
  lotteryPhase,
  parseActivityRequest,
  parsePrizesRequest,
  pickFreeCode,
  pickWeightedPrize,
  prizeConfigError,
  timeWindowError,
} from "../src/routes/lottery.js";

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
  /** #865 draw 参与记录（内存版，含三重唯一约束语义）。 */
  participationRows: LotteryParticipationRow[] = [];
  drawCalls: { activityId: number; userId: string; providerKey: string }[] = [];
  /** #866 staff 白名单（内存版）：全局行 + 活动级行。 */
  readonly staffGlobal = new Set<string>();
  readonly staffByActivity = new Map<string, number>();
  /** #866 核销留痕（内存版）。 */
  readonly verificationLogs: LotteryVerificationLogInput[] = [];

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

  async getPrize(id: number): Promise<LotteryPrizeRow | null> {
    for (const prizes of this.prizesByActivity.values()) {
      const prize = prizes.find((row) => row.id === id);
      if (prize !== undefined) return { ...prize };
    }
    return null;
  }

  async hasParticipations(activityId: number): Promise<boolean> {
    return this.participations.has(activityId) || this.participationRows.some((row) => row.activityId === activityId);
  }

  async getParticipation(activityId: number, userId: string): Promise<LotteryParticipationRow | null> {
    const row = this.participationRows.find((candidate) => candidate.activityId === activityId && candidate.userId === userId);
    return row === undefined ? null : { ...row };
  }

  async drawParticipation(input: {
    activityId: number;
    userId: string;
    providerKey: string;
    allocate(prizes: LotteryPrizeRow[], occupiedCodes: ReadonlySet<string>): DrawAllocation;
  }) {
    this.drawCalls.push({ activityId: input.activityId, userId: input.userId, providerKey: input.providerKey });
    const existing = this.participationRows.find((row) => row.activityId === input.activityId && row.userId === input.userId);
    if (existing !== undefined) {
      return { outcome: "duplicate" as const, participation: { ...existing }, prize: await this.prizeOf(existing) };
    }
    // uk_activity_provider：同一手表账号（provider_key）已抽过本活动。
    const providerHit = this.participationRows.find((row) => row.activityId === input.activityId && row.providerKey === input.providerKey);
    if (providerHit !== undefined) {
      return { outcome: "provider_conflict" as const };
    }
    const prizes = this.prizesByActivity.get(input.activityId) ?? [];
    const occupied = new Set(
      this.participationRows.filter((row) => row.activityId === input.activityId && row.code !== null).map((row) => row.code as string),
    );
    const allocation = input.allocate(prizes, occupied);
    const row: LotteryParticipationRow = {
      id: this.nextId++,
      activityId: input.activityId,
      userId: input.userId,
      openid: null,
      providerKey: input.providerKey,
      prizeId: allocation.prize.id,
      code: allocation.prize.isFallback ? null : allocation.code,
      status: "drawn",
      verifiedBy: null,
      verifiedAt: null,
      createdAt: new Date("2026-11-03T10:00:00Z"),
    };
    if (!allocation.prize.isFallback) {
      allocation.prize.remaining -= 1;
    }
    this.participationRows.push(row);
    return { outcome: "created" as const, participation: { ...row }, prize: { ...allocation.prize } };
  }

  private async prizeOf(participation: LotteryParticipationRow): Promise<LotteryPrizeRow | null> {
    return participation.prizeId === null ? null : this.getPrize(participation.prizeId);
  }

  async isStaffOpenid(openid: string, activityId: number): Promise<boolean> {
    return this.staffGlobal.has(openid) || this.staffByActivity.get(openid) === activityId;
  }

  async findWinningByCode(input: { activityId: number; openid: string; code: string }): Promise<LotteryParticipationRow | null> {
    const row = this.participationRows.find((candidate) => candidate.activityId === input.activityId && candidate.code === input.code);
    this.verificationLogs.push({
      activityId: input.activityId,
      openid: input.openid,
      action: "lookup",
      code: input.code,
      outcome: row === undefined ? "not_found" : "found",
      participationId: row?.id ?? null,
    });
    return row === undefined ? null : { ...row };
  }

  async redeemParticipation(input: { activityId: number; code: string; verifiedBy: string; verifiedAt: Date }): Promise<RedeemOutcome> {
    const row = this.participationRows.find((candidate) => candidate.activityId === input.activityId && candidate.code === input.code);
    if (row === undefined) {
      this.verificationLogs.push({ activityId: input.activityId, openid: input.verifiedBy, action: "redeem", code: input.code, outcome: "not_found", participationId: null });
      return { outcome: "not_found" };
    }
    if (row.status === "verified") {
      this.verificationLogs.push({ activityId: input.activityId, openid: input.verifiedBy, action: "redeem", code: input.code, outcome: "already_verified", participationId: row.id });
      return { outcome: "already_verified", participation: { ...row } };
    }
    row.status = "verified";
    row.verifiedBy = input.verifiedBy;
    row.verifiedAt = input.verifiedAt;
    this.verificationLogs.push({ activityId: input.activityId, openid: input.verifiedBy, action: "redeem", code: input.code, outcome: "redeemed", participationId: row.id });
    return { outcome: "redeemed", participation: { ...row } };
  }
}

/** 服务端绑表硬校验假件：credential 为 null 模拟未绑/未登录。 */
class FakeWatchReader implements WatchCredentialReader {
  constructor(readonly credential: { providerKey: string } | null = { providerKey: "coros:runner@example.com" }) {}
  async getLoggedInWatch(): Promise<{ providerKey: string } | null> {
    return this.credential;
  }
}

/** fail-soft 同步触发假件：只记调用。 */
class FakeSyncTrigger implements LotterySyncTrigger {
  readonly calls: { activityId: number; userId: string }[] = [];
  async triggerFullSyncIfNewUser(activityId: number, userId: string): Promise<void> {
    this.calls.push({ activityId, userId });
  }
}

/** #866 openid 解析假件：按预设结果回放，记录收到的 wx code。 */
class FakeOpenidResolver implements LotteryOpenidResolver {
  readonly calls: string[] = [];
  constructor(private readonly resolution: OpenidResolution) {}
  async resolve(wxCode: string): Promise<OpenidResolution> {
    this.calls.push(wxCode);
    return this.resolution;
  }
}

function lotteryApp(
  options: {
    store?: FakeLotteryStore;
    adminVerifier?: boolean;
    watch?: FakeWatchReader;
    sync?: FakeSyncTrigger;
    /** #866 核销域的 openid resolver；缺省不挂（端点 503）。 */
    verifyOpenid?: LotteryOpenidResolver;
  } = {},
) {
  const store = options.store ?? new FakeLotteryStore();
  const sync = options.sync ?? new FakeSyncTrigger();
  return {
    store,
    sync,
    app: createApp({
      jwtVerifier: verifierFor(options.adminVerifier ?? true),
      coachInvoker: {
        async invoke() {
          throw new Error("must not invoke");
        },
        streamEvents: neverStream,
      },
      lottery: store,
      lotteryDraw: { store, watch: options.watch ?? new FakeWatchReader(), sync },
      lotteryVerify: { store, ...(options.verifyOpenid !== undefined ? { openid: options.verifyOpenid } : {}) },
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

// ── #865 纯函数：库存感知权重抽取 + 3 位编号 ──────────────────────────

test("pickWeightedPrize：零库存档跳过并重新归一化；实物全空落兜底档", () => {
  const physicalA: LotteryPrizeRow = { id: 1, activityId: 5, name: "A", imageUrl: null, stock: 1, remaining: 0, weight: 99, isFallback: false };
  const physicalB: LotteryPrizeRow = { id: 2, activityId: 5, name: "B", imageUrl: null, stock: 1, remaining: 1, weight: 1, isFallback: false };
  const fallback: LotteryPrizeRow = { id: 3, activityId: 5, name: "谢谢参与", imageUrl: null, stock: 0, remaining: 0, weight: 5, isFallback: true };

  // A 零库存：可掷域只剩 B 的权重 1（randomInt(1) 恒 0），必落 B——权重 99:1 被库存归零。
  assert.equal(pickWeightedPrize([physicalA, physicalB, fallback], () => 0).id, 2);
  // 实物全空 → 兜底档。
  assert.equal(pickWeightedPrize([{ ...physicalA }, { ...physicalB, remaining: 0 }, fallback], () => 0).isFallback, true);
});

test("pickWeightedPrize：权重边界——掷 0 落首档、掷 total-1 落末档、跨档游标正确", () => {
  const a: LotteryPrizeRow = { id: 1, activityId: 5, name: "A", imageUrl: null, stock: 3, remaining: 3, weight: 3, isFallback: false };
  const b: LotteryPrizeRow = { id: 2, activityId: 5, name: "B", imageUrl: null, stock: 3, remaining: 3, weight: 7, isFallback: false };
  const fallback: LotteryPrizeRow = { id: 3, activityId: 5, name: "谢谢参与", imageUrl: null, stock: 0, remaining: 0, weight: 5, isFallback: true };
  assert.equal(pickWeightedPrize([a, b, fallback], () => 0).id, 1);
  assert.equal(pickWeightedPrize([a, b, fallback], () => 2).id, 1);
  assert.equal(pickWeightedPrize([a, b, fallback], () => 3).id, 2);
  assert.equal(pickWeightedPrize([a, b, fallback], () => 9).id, 2);
});

test("pickFreeCode：000-999 补零、避开已占、全满返回 null", () => {
  const free = pickFreeCode(new Set(["000"]), () => 0);
  assert.equal(free, "001"); // 000 已占 → 首个空闲 001
  assert.equal(pickFreeCode(new Set(), () => 6), "006"); // 补零 3 位
  // 占用 042：其前面的编号索引不动（free[41]="041"），后面的整体前移（free[42]="043"）。
  assert.equal(pickFreeCode(new Set(["042"]), () => 41), "041");
  assert.equal(pickFreeCode(new Set(["042"]), () => 42), "043");
  // 全满（000-999 全占）→ null。
  const all = new Set<string>();
  for (let n = 0; n <= 999; n++) all.add(n.toString().padStart(3, "0"));
  assert.equal(pickFreeCode(all, () => 0), null);
});

// ── #865 路由：POST draw ──────────────────────────────────────────────

/** draw 测试用的内存层奖池（LotteryPrizeInput 驼峰形态）。 */
const DRAW_POOL: LotteryPrizeInput[] = [
  { name: "一等奖 运动手表", imageUrl: "https://cos.example.com/p1.png", stock: 2, weight: 1, isFallback: false },
  { name: "谢谢参与", stock: 0, weight: 5, isFallback: true },
];

/** 时间窗覆盖当前时刻的活动（enabled + 奖池配齐），返回活动 id。 */
async function activeActivity(store: FakeLotteryStore, prizes: LotteryPrizeInput[] = DRAW_POOL): Promise<number> {
  const activity = await store.createActivity({
    name: "进行中",
    startAt: new Date(Date.now() - 60 * 60 * 1000),
    endAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  store.activities.get(activity.id)!.enabled = true;
  await store.replacePrizes(activity.id, prizes);
  return activity.id;
}

test("draw：登录+绑表+进行中 → 201 中奖结果（3 位编号、不泄漏权重）；扣库存；触发同步", async () => {
  const { app, store, sync } = lotteryApp({ adminVerifier: false });
  const id = await activeActivity(store);

  const draw = await app.request(`/api/lottery/activities/${id}/draw`, { method: "POST", headers: AUTH });
  assert.equal(draw.status, 201);
  const body = (await draw.json()) as Record<string, unknown>;
  assert.equal(body.deduplicated, false);
  assert.equal(body.status, "drawn");
  assert.match(String(body.code), /^[0-9]{3}$/);
  const prize = body.prize as Record<string, unknown>;
  assert.equal("weight" in prize, false);
  assert.equal("stock" in prize, false);
  assert.equal("remaining" in prize, false);

  // 中奖档库存被扣减。
  const physical = store.prizesByActivity.get(id)!.find((row) => !row.isFallback)!;
  assert.equal(physical.remaining, physical.stock - 1);
  // 首次开奖触发全量同步（fail-soft 端口被调用一次）。
  assert.deepEqual(sync.calls, [{ activityId: id, userId: "athlete-1" }]);
});

test("draw：重复参与 → 200 返回已有结果（deduplicated）且不再触发同步", async () => {
  const { app, store, sync } = lotteryApp({ adminVerifier: false });
  const id = await activeActivity(store);
  const first = await app.request(`/api/lottery/activities/${id}/draw`, { method: "POST", headers: AUTH });
  assert.equal(first.status, 201);

  const replay = await app.request(`/api/lottery/activities/${id}/draw`, { method: "POST", headers: AUTH });
  assert.equal(replay.status, 200);
  const body = (await replay.json()) as Record<string, unknown>;
  assert.equal(body.deduplicated, true);
  assert.equal(body.code, ((await first.json()) as { code: string }).code);
  // 只有一次存储层 draw 调用被幂等收敛；同步触发不重复。
  assert.equal(store.drawCalls.length, 2);
  assert.equal(sync.calls.length, 1);
});

test("draw：同一手表账号绑到另一账号已抽过 → 409 watch_already_drawn", async () => {
  const { app, store } = lotteryApp({ adminVerifier: false });
  const id = await activeActivity(store);
  // 另一个 stride 账号已用同一 provider_key 抽过本活动。
  store.participationRows.push({
    id: 99,
    activityId: id,
    userId: "someone-else",
    openid: null,
    providerKey: "coros:runner@example.com",
    prizeId: 1,
    code: "077",
    status: "drawn",
    verifiedBy: null,
    verifiedAt: null,
    createdAt: new Date("2026-11-03T09:00:00Z"),
  });

  const draw = await app.request(`/api/lottery/activities/${id}/draw`, { method: "POST", headers: AUTH });
  assert.equal(draw.status, 409);
  assert.equal(((await draw.json()) as { error: string }).error, "watch_already_drawn");
});

test("draw：服务端硬校验——未登录 401 / 未绑表 403 / 未开始或已结束 403 / 未启用 404 / 非法 id 400", async () => {
  const { app, store } = lotteryApp({ adminVerifier: false });

  const anonymous = await app.request(`/api/lottery/activities/1/draw`, { method: "POST" });
  assert.equal(anonymous.status, 401);

  const id = await activeActivity(store);

  // 未绑表（或绑定但 secret 为空）：watch 读取返回 null → 403。
  const unbound = lotteryApp({ adminVerifier: false, watch: new FakeWatchReader(null), store });
  const unboundDraw = await unbound.app.request(`/api/lottery/activities/${id}/draw`, { method: "POST", headers: AUTH });
  assert.equal(unboundDraw.status, 403);
  assert.equal(((await unboundDraw.json()) as { error: string }).error, "watch_not_bound");
  assert.equal(store.drawCalls.length, 0, "watch 未过门不得进 draw 事务");

  // 未开始 / 已结束：phase 403。
  const future = await store.createActivity({ name: "未开始", startAt: new Date(Date.now() + 3600_000), endAt: new Date(Date.now() + 7200_000) });
  store.activities.get(future.id)!.enabled = true;
  await store.replacePrizes(future.id, DRAW_POOL);
  const notStarted = await app.request(`/api/lottery/activities/${future.id}/draw`, { method: "POST", headers: AUTH });
  assert.equal(notStarted.status, 403);
  const notStartedBody = (await notStarted.json()) as { error: string; phase: string };
  assert.equal(notStartedBody.error, "activity_not_active");
  assert.equal(notStartedBody.phase, "not_started");

  const past = await store.createActivity({ name: "已结束", startAt: new Date(Date.now() - 7200_000), endAt: new Date(Date.now() - 3600_000) });
  store.activities.get(past.id)!.enabled = true;
  await store.replacePrizes(past.id, DRAW_POOL);
  const ended = await app.request(`/api/lottery/activities/${past.id}/draw`, { method: "POST", headers: AUTH });
  assert.equal(((await ended.json()) as { phase: string }).phase, "ended");

  // 未启用与不存在同口径 404。
  const disabled = await store.createActivity({ name: "未启用", startAt: new Date(Date.now() - 3600_000), endAt: new Date(Date.now() + 3600_000) });
  await store.replacePrizes(disabled.id, DRAW_POOL);
  assert.equal((await app.request(`/api/lottery/activities/${disabled.id}/draw`, { method: "POST", headers: AUTH })).status, 404);
  assert.equal((await app.request("/api/lottery/activities/999/draw", { method: "POST", headers: AUTH })).status, 404);

  // 非法活动 id → 400。
  assert.equal((await app.request("/api/lottery/activities/x/draw", { method: "POST", headers: AUTH })).status, 400);
});

test("draw：实物全空 → 落「谢谢参与」（code=null），不触发扣减", async () => {
  const { app, store } = lotteryApp({ adminVerifier: false });
  const id = await activeActivity(store);
  // 先把实物库存抽空。
  store.prizesByActivity.get(id)!.find((row) => !row.isFallback)!.remaining = 0;

  const draw = await app.request(`/api/lottery/activities/${id}/draw`, { method: "POST", headers: AUTH });
  assert.equal(draw.status, 201);
  const body = (await draw.json()) as Record<string, unknown>;
  assert.equal((body.prize as { is_fallback: boolean }).is_fallback, true);
  assert.equal(body.code, null);
});

// ── #865 路由：GET my-result ──────────────────────────────────────────

test("my-result：未参与 200 participated:false；参与后返回编号+奖品+核销状态", async () => {
  const { app, store } = lotteryApp({ adminVerifier: false });
  const id = await activeActivity(store);

  const before = await app.request(`/api/lottery/activities/${id}/my-result`, { headers: AUTH });
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), { participated: false });

  const drawBody = (await (await app.request(`/api/lottery/activities/${id}/draw`, { method: "POST", headers: AUTH })).json()) as {
    code: string;
  };
  const after = await app.request(`/api/lottery/activities/${id}/my-result`, { headers: AUTH });
  assert.equal(after.status, 200);
  const result = (await after.json()) as Record<string, unknown>;
  assert.equal(result.participated, true);
  assert.equal(result.code, drawBody.code);
  assert.equal(result.status, "drawn");
  assert.equal(result.verified_at, null);
  assert.equal("weight" in (result.prize as Record<string, unknown>), false);

  // my-result 也要求登录态。
  assert.equal((await app.request(`/api/lottery/activities/${id}/my-result`)).status, 401);
  // 非法 id → 400。
  assert.equal((await app.request(`/api/lottery/activities/x/my-result`, { headers: AUTH })).status, 400);
});

// ── #866 核销域：staff 查询/核销端点 ──────────────────────────────────

const STAFF_OPENID = "staff-openid-ABC";
const WINNER_CODE = "042";

/** 核销测试台：启用中的活动 + 实物奖池 + 一条 042 待核销中奖记录。 */
async function verifyFixture() {
  const store = new FakeLotteryStore();
  const activity = await store.createActivity({
    name: "核销场",
    startAt: new Date(Date.now() - 3_600_000),
    endAt: new Date(Date.now() + 3_600_000),
  });
  store.activities.get(activity.id)!.enabled = true;
  await store.replacePrizes(activity.id, DRAW_POOL);
  const physical = (await store.listPrizes(activity.id)).find((prize) => !prize.isFallback)!;
  store.participationRows.push({
    id: 501,
    activityId: activity.id,
    userId: "winner-1",
    openid: null,
    providerKey: "coros:winner@example.com",
    prizeId: physical.id,
    code: WINNER_CODE,
    status: "drawn",
    verifiedBy: null,
    verifiedAt: null,
    createdAt: new Date("2026-11-03T10:00:00Z"),
  });
  return { store, activityId: activity.id };
}

function verifyBody(code: string = WINNER_CODE): string {
  return JSON.stringify({ code, wx_code: "fresh-wx-login-code" });
}

test("verify：resolver 未配置 / 上游不可用 → 503，不触达活动与白名单", async () => {
  const { store, activityId } = await verifyFixture();

  const unconfigured = lotteryApp({ adminVerifier: false, store });
  for (const path of ["verify/lookup", "verify/redeem"] as const) {
    const response = await unconfigured.app.request(`/api/lottery/activities/${activityId}/${path}`, {
      method: "POST",
      headers: AUTH,
      body: verifyBody(),
    });
    assert.equal(response.status, 503, `${path} 未配置 resolver 应 503`);
    assert.equal(((await response.json()) as { error: string }).error, "verify_openid_unavailable");
  }

  const upstreamDown = lotteryApp({ adminVerifier: false, store, verifyOpenid: new FakeOpenidResolver({ status: "unavailable" }) });
  const failed = await upstreamDown.app.request(`/api/lottery/activities/${activityId}/verify/lookup`, {
    method: "POST",
    headers: AUTH,
    body: verifyBody(),
  });
  assert.equal(failed.status, 503);
  // 上游失败同样不触达白名单/留痕。
  assert.equal(store.verificationLogs.length, 0);
});

test("verify：非白名单 → 403 not_staff 且响应体回显请求者自己的 openid", async () => {
  const { store, activityId } = await verifyFixture();
  const { app } = lotteryApp({
    adminVerifier: false,
    store,
    verifyOpenid: new FakeOpenidResolver({ status: "ok", openid: "random-visitor-openid" }),
  });

  for (const path of ["verify/lookup", "verify/redeem"] as const) {
    const response = await app.request(`/api/lottery/activities/${activityId}/${path}`, {
      method: "POST",
      headers: AUTH,
      body: verifyBody(),
    });
    assert.equal(response.status, 403, `${path} 非白名单应 403`);
    const body = (await response.json()) as { error: string; openid: string };
    assert.equal(body.error, "not_staff");
    assert.equal(body.openid, "random-visitor-openid");
  }
  // 被拒的请求不产生查询/核销留痕。
  assert.equal(store.verificationLogs.length, 0);
});

test("verify lookup：白名单（全局行/活动级行）→ 200 中奖详情；查无编号 → 404 code_not_found", async () => {
  const { store, activityId } = await verifyFixture();
  store.staffGlobal.add(STAFF_OPENID);
  const { app } = lotteryApp({ adminVerifier: false, store, verifyOpenid: new FakeOpenidResolver({ status: "ok", openid: STAFF_OPENID }) });

  const found = await app.request(`/api/lottery/activities/${activityId}/verify/lookup`, { method: "POST", headers: AUTH, body: verifyBody() });
  assert.equal(found.status, 200);
  const entry = (await found.json()) as Record<string, unknown>;
  assert.equal(entry.code, WINNER_CODE);
  assert.equal(entry.status, "drawn");
  assert.equal(entry.verified_at, null);
  assert.equal(entry.verified_by, null);
  assert.equal(entry.won_at, "2026-11-03T10:00:00.000Z");
  const prize = entry.prize as Record<string, unknown>;
  assert.equal(prize.name, "一等奖 运动手表");
  assert.equal(prize.image_url, "https://cos.example.com/p1.png");
  assert.equal("weight" in prize, false);

  // 查无编号：「谢谢参与」不占编号，编号只存在于中奖记录。
  const missing = await app.request(`/api/lottery/activities/${activityId}/verify/lookup`, {
    method: "POST",
    headers: AUTH,
    body: verifyBody("999"),
  });
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: string }).error, "code_not_found");

  // 全量留痕：found + not_found 各一行。
  assert.deepEqual(
    store.verificationLogs.map((log) => `${log.action}:${log.outcome}:${log.code}`),
    ["lookup:found:042", "lookup:not_found:999"],
  );

  // 活动级白名单行同样命中（全局集合清空后仅靠活动级行放行）。
  store.staffGlobal.clear();
  store.staffByActivity.set("activity-staff-openid", activityId);
  const activityScoped = lotteryApp({
    adminVerifier: false,
    store,
    verifyOpenid: new FakeOpenidResolver({ status: "ok", openid: "activity-staff-openid" }),
  });
  const scoped = await activityScoped.app.request(`/api/lottery/activities/${activityId}/verify/lookup`, {
    method: "POST",
    headers: AUTH,
    body: verifyBody(),
  });
  assert.equal(scoped.status, 200);
});

test("verify lookup：非法 code / 缺 wx_code / 非法活动 id / 未登录 / 活动未启用或不存在", async () => {
  const { store, activityId } = await verifyFixture();
  store.staffGlobal.add(STAFF_OPENID);
  const { app } = lotteryApp({ adminVerifier: false, store, verifyOpenid: new FakeOpenidResolver({ status: "ok", openid: STAFF_OPENID }) });

  for (const badCode of ["42", "0042", "abc", ""]) {
    const response = await app.request(`/api/lottery/activities/${activityId}/verify/lookup`, {
      method: "POST",
      headers: AUTH,
      body: verifyBody(badCode),
    });
    assert.equal(response.status, 400, `code=${badCode} 应 400`);
    assert.equal(((await response.json()) as { error: string }).error, "invalid_code");
  }
  const noWxCode = await app.request(`/api/lottery/activities/${activityId}/verify/lookup`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ code: WINNER_CODE }),
  });
  assert.equal(((await noWxCode.json()) as { error: string }).error, "invalid_wx_code");

  assert.equal((await app.request("/api/lottery/activities/x/verify/lookup", { method: "POST", headers: AUTH, body: verifyBody() })).status, 400);
  assert.equal((await app.request(`/api/lottery/activities/${activityId}/verify/lookup`, { method: "POST", body: verifyBody() })).status, 401);

  // 活动不存在 / 未启用 → 404（与公开端点同口径）。
  assert.equal((await app.request("/api/lottery/activities/999/verify/lookup", { method: "POST", headers: AUTH, body: verifyBody() })).status, 404);
  store.activities.get(activityId)!.enabled = false;
  const disabled = await app.request(`/api/lottery/activities/${activityId}/verify/lookup`, { method: "POST", headers: AUTH, body: verifyBody() });
  assert.equal(disabled.status, 404);
  // 结构校验先于 resolver：非法 code 不消费 wx code。
  assert.equal(store.verificationLogs.length, 0);
});

test("verify redeem：待核销 → 200 首次核销（already_verified:false，落核销人+时间）；再核销回显既有结果拒绝变更", async () => {
  const { store, activityId } = await verifyFixture();
  store.staffGlobal.add(STAFF_OPENID);
  const { app } = lotteryApp({ adminVerifier: false, store, verifyOpenid: new FakeOpenidResolver({ status: "ok", openid: STAFF_OPENID }) });

  const first = await app.request(`/api/lottery/activities/${activityId}/verify/redeem`, { method: "POST", headers: AUTH, body: verifyBody() });
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as Record<string, unknown>;
  assert.equal(firstBody.already_verified, false);
  assert.equal(firstBody.status, "verified");
  assert.equal(firstBody.verified_by, STAFF_OPENID);
  assert.equal(typeof firstBody.verified_at, "string");
  const firstVerifiedAt = firstBody.verified_at as string;
  const prize = firstBody.prize as Record<string, unknown>;
  assert.equal(prize.name, "一等奖 运动手表");

  // 核销后 lookup 也呈已核销态。
  const after = await app.request(`/api/lottery/activities/${activityId}/verify/lookup`, { method: "POST", headers: AUTH, body: verifyBody() });
  const afterBody = (await after.json()) as Record<string, unknown>;
  assert.equal(afterBody.status, "verified");
  assert.equal(afterBody.verified_by, STAFF_OPENID);

  // 另一位 staff 再次核销同一编号：回显首次核销人+时间，状态不变。
  const second = await app.request(`/api/lottery/activities/${activityId}/verify/redeem`, { method: "POST", headers: AUTH, body: verifyBody() });
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as Record<string, unknown>;
  assert.equal(secondBody.already_verified, true);
  assert.equal(secondBody.verified_by, STAFF_OPENID);
  assert.equal(secondBody.verified_at, firstVerifiedAt);

  // 核销编号不存在 → 404。
  const missing = await app.request(`/api/lottery/activities/${activityId}/verify/redeem`, {
    method: "POST",
    headers: AUTH,
    body: verifyBody("999"),
  });
  assert.equal(((await missing.json()) as { error: string }).error, "code_not_found");

  assert.deepEqual(
    store.verificationLogs.map((log) => `${log.action}:${log.outcome}`),
    ["redeem:redeemed", "lookup:found", "redeem:already_verified", "redeem:not_found"],
  );
});

test("verify 限速：同 openid 第 31 次 → 429（查询+核销共享预算）；不同 openid 互不影响", async () => {
  const { store, activityId } = await verifyFixture();
  store.staffGlobal.add(STAFF_OPENID);
  store.staffGlobal.add("staff-openid-B");
  const staffA = lotteryApp({ adminVerifier: false, store, verifyOpenid: new FakeOpenidResolver({ status: "ok", openid: STAFF_OPENID }) });
  const staffB = lotteryApp({ adminVerifier: false, store, verifyOpenid: new FakeOpenidResolver({ status: "ok", openid: "staff-openid-B" }) });

  // 30 次（预算上限）全部放行。
  for (let i = 0; i < 30; i++) {
    const response = await staffA.app.request(`/api/lottery/activities/${activityId}/verify/lookup`, {
      method: "POST",
      headers: AUTH,
      body: verifyBody("999"),
    });
    assert.equal(response.status, 404, `第 ${i + 1} 次不应被限速`);
  }
  const throttled = await staffA.app.request(`/api/lottery/activities/${activityId}/verify/lookup`, {
    method: "POST",
    headers: AUTH,
    body: verifyBody("999"),
  });
  assert.equal(throttled.status, 429);
  assert.equal(((await throttled.json()) as { error: string }).error, "rate_limited");
  assert.equal(throttled.headers.get("retry-after"), "60");
  // 共享预算：同 openid 的 redeem 也一并被限。
  const throttledRedeem = await staffA.app.request(`/api/lottery/activities/${activityId}/verify/redeem`, {
    method: "POST",
    headers: AUTH,
    body: verifyBody(),
  });
  assert.equal(throttledRedeem.status, 429);

  // 另一个 openid 不受影响（限速键是 openid，非活动/编号）。
  const otherStaff = await staffB.app.request(`/api/lottery/activities/${activityId}/verify/lookup`, {
    method: "POST",
    headers: AUTH,
    body: verifyBody(),
  });
  assert.equal(otherStaff.status, 200);
});
