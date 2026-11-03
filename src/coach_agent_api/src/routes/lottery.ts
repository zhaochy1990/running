/**
 * Lottery endpoints (#863 activity configuration, #865 draw core, #866 verify).
 *
 * Admin CRUD (`/api/admin/lottery/...`) sits behind the auth middleware plus
 * the admin gate — the运营 dashboard's only configuration surface. The landing
 * page read (`GET /api/lottery/activities/:id`) is public, registered outside
 * every auth prefix like the coach-share read: it serves display fields only
 * (tier name/image/remaining stock, rules copy, time-window phase) and never
 * weights or other internal configuration. Disabled and unknown activities are
 * the same 404 so the public surface leaks nothing about unpublished configs.
 *
 * Configuration is validated as a whole pool (#862 决策5): exactly one
 * 「谢谢参与」fallback tier (with no stock of its own), every weight > 0, and
 * total physical stock ≤ 999 — the 3-digit winning-code space the draw
 * allocates from.
 *
 * The #865 draw (`POST .../draw`) and `GET .../my-result` are user-tier
 * authenticated. Every gate is re-derived server-side (#862 决策2): activity
 * enabled + inside its time window, a logged-in watch binding
 * (watchCredentials, logged_in semantics), then the transactional draw with
 * the three unique constraints as the anti-replay backstop — a repeat draw
 * returns the committed result (200) instead of an error. After a fresh draw
 * the full-sync trigger fires fail-soft in the background.
 */
import { randomInt } from "node:crypto";
import type { Hono, MiddlewareHandler } from "hono";
import { type AuthEnv, createAdminMiddleware } from "../auth.js";
import type { LotteryOpenidResolver } from "../coach/lotteryOpenid.js";
import type { LotterySyncTrigger } from "../coach/lotterySyncTrigger.js";
import type { DrawOutcome, LotteryActivityRow, LotteryParticipationRow, LotteryPrizeRow, LotteryStore } from "../persistence/lottery.js";
import type { WatchCredentialReader } from "../persistence/watchCredentials.js";
// IpRateLimiter 是通用固定窗口计数器（key 任意），这里以 openid 为 key 复用。
import { IpRateLimiter } from "./shares.js";

export type LotteryPhase = "not_started" | "active" | "ended";

/** 中奖编号 3 位数字（000-999）的码空间硬约束：单活动奖品总库存 ≤ 999（#862 决策5）。 */
export const MAX_TOTAL_STOCK = 999;

const MAX_NAME_CHARS = 128;
const MAX_RULES_CHARS = 20_000;
const MAX_URL_CHARS = 512;
const MAX_PRIZE_TIERS = 50;
const MAX_WEIGHT = 1_000_000;
/** Path ids are numeric activity ids (scene `a=<活动ID>`); cap length, not value. */
const ACTIVITY_ID_RE = /^\d{1,15}$/;
/** 小程序图片仅支持 https；无 schema 的相对路径在公网落地页无法展示。 */
const HTTPS_URL_RE = /^https:\/\/\S+$/;
/** 时间窗必须带显式时区（Z 或 ±HH:MM）——「2026-11-10 10:00:00」这类本地时间歧义输入直接拒绝。 */
const ISO_WITH_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export interface ParsedActivity {
  name: string;
  startAt: Date;
  endAt: Date;
  rulesText?: string;
  heroImage?: string;
}

export interface ParsedPrize {
  name: string;
  imageUrl?: string;
  stock: number;
  weight: number;
  isFallback: boolean;
}

/** 时间窗状态：未开始 / 进行中 / 已结束（边界归属：起点即进行中，终点仍进行中）。 */
export function lotteryPhase(startAt: Date, endAt: Date, now: Date = new Date()): LotteryPhase {
  if (now.getTime() < startAt.getTime()) return "not_started";
  if (now.getTime() > endAt.getTime()) return "ended";
  return "active";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string" || !ISO_WITH_TZ_RE.test(value)) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Activity body (create + full update, custom-races 风格的 PUT 语义).
 * Structural problems are error codes (400); the start<end business rule is
 * reported separately so the route can answer 422.
 */
export function parseActivityRequest(body: unknown): { ok: true; value: ParsedActivity } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "invalid_request" };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0 || name.length > MAX_NAME_CHARS) return { ok: false, error: "invalid_name" };

  const startAt = parseTimestamp(body.start_at);
  if (startAt === undefined) return { ok: false, error: "invalid_start_at" };
  const endAt = parseTimestamp(body.end_at);
  if (endAt === undefined) return { ok: false, error: "invalid_end_at" };

  const rulesRaw = body.rules_text;
  let rulesText: string | undefined;
  if (rulesRaw !== undefined && rulesRaw !== null) {
    if (typeof rulesRaw !== "string" || rulesRaw.length > MAX_RULES_CHARS) return { ok: false, error: "invalid_rules_text" };
    rulesText = rulesRaw.length === 0 ? undefined : rulesRaw;
  }
  const heroRaw = body.hero_image;
  let heroImage: string | undefined;
  if (heroRaw !== undefined && heroRaw !== null) {
    if (typeof heroRaw !== "string" || !HTTPS_URL_RE.test(heroRaw) || heroRaw.length > MAX_URL_CHARS) {
      return { ok: false, error: "invalid_hero_image" };
    }
    heroImage = heroRaw;
  }
  return { ok: true, value: { name, startAt, endAt, ...(rulesText !== undefined ? { rulesText } : {}), ...(heroImage !== undefined ? { heroImage } : {}) } };
}

/** Prize-pool body: `{ prizes: [...] }`; per-tier structural problems are 400s. */
export function parsePrizesRequest(body: unknown): { ok: true; value: ParsedPrize[] } | { ok: false; error: string } {
  if (!isRecord(body) || !Array.isArray(body.prizes)) return { ok: false, error: "invalid_request" };
  const prizes = body.prizes;
  if (prizes.length === 0 || prizes.length > MAX_PRIZE_TIERS) return { ok: false, error: "invalid_prizes" };

  const parsed: ParsedPrize[] = [];
  for (const raw of prizes) {
    if (!isRecord(raw)) return { ok: false, error: "invalid_prizes" };
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (name.length === 0 || name.length > MAX_NAME_CHARS) return { ok: false, error: "invalid_prize_name" };

    const stock = raw.stock;
    if (typeof stock !== "number" || !Number.isInteger(stock) || stock < 0 || stock > MAX_TOTAL_STOCK) {
      return { ok: false, error: "invalid_stock" };
    }
    const weight = raw.weight;
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight <= 0 || weight > MAX_WEIGHT) {
      return { ok: false, error: "invalid_weight" };
    }
    const isFallback = raw.is_fallback;
    if (typeof isFallback !== "boolean") return { ok: false, error: "invalid_is_fallback" };

    const imageRaw = raw.image_url;
    let imageUrl: string | undefined;
    if (imageRaw !== undefined && imageRaw !== null) {
      if (typeof imageRaw !== "string" || !HTTPS_URL_RE.test(imageRaw) || imageRaw.length > MAX_URL_CHARS) {
        return { ok: false, error: "invalid_image_url" };
      }
      imageUrl = imageRaw;
    }
    parsed.push({ name, stock, weight, isFallback, ...(imageUrl !== undefined ? { imageUrl } : {}) });
  }
  return { ok: true, value: parsed };
}

/**
 * Whole-pool business rules (#862 决策4/5). Returns the 422 message when the
 * configuration violates a rule, undefined when it is sound:
 *   - 必有且仅有一个「谢谢参与」兜底档（draw 全空时落它，库存不设限 → stock 恒 0）
 *   - 奖档权重 > 0 已在 parse 层保证
 *   - 单活动奖品总库存 ≤ 999（3 位编号码空间）
 */
export function prizeConfigError(prizes: ParsedPrize[]): string | undefined {
  const fallbacks = prizes.filter((prize) => prize.isFallback);
  if (fallbacks.length !== 1) {
    return "每个活动必须有且仅有一个「谢谢参与」兜底档";
  }
  if (fallbacks[0]?.stock !== 0) {
    return "「谢谢参与」兜底档不设库存，请填 0";
  }
  const totalStock = prizes.reduce((sum, prize) => sum + prize.stock, 0);
  if (totalStock > MAX_TOTAL_STOCK) {
    return `单活动奖品总库存不能超过 ${MAX_TOTAL_STOCK}（当前 ${totalStock}）`;
  }
  return undefined;
}

/** Time-window business rule (422): the window must be non-empty. */
export function timeWindowError(activity: ParsedActivity): string | undefined {
  if (activity.startAt.getTime() >= activity.endAt.getTime()) {
    return "开始时间必须早于结束时间";
  }
  return undefined;
}

function activityIdParam(context: { req: { param(name: string): string | undefined } }): number | null {
  const raw = context.req.param("id") ?? "";
  if (!ACTIVITY_ID_RE.test(raw)) return null;
  return Number(raw);
}

function activityResponse(activity: LotteryActivityRow): Record<string, unknown> {
  return {
    id: activity.id,
    name: activity.name,
    start_at: activity.startAt.toISOString(),
    end_at: activity.endAt.toISOString(),
    enabled: activity.enabled,
    rules_text: activity.rulesText,
    hero_image: activity.heroImage,
    status: lotteryPhase(activity.startAt, activity.endAt),
    created_at: activity.createdAt.toISOString(),
    updated_at: activity.updatedAt.toISOString(),
  };
}

function prizeResponse(prize: LotteryPrizeRow): Record<string, unknown> {
  return {
    id: prize.id,
    name: prize.name,
    image_url: prize.imageUrl,
    stock: prize.stock,
    remaining: prize.remaining,
    weight: prize.weight,
    is_fallback: prize.isFallback,
  };
}

export interface LotteryRouteDeps {
  store: LotteryStore;
}

export interface LotteryDrawRouteDeps {
  store: LotteryStore;
  /** Server-side watch-binding hard gate (#862 决策2); re-checked on every draw. */
  watch: WatchCredentialReader;
  /** Fail-soft post-draw full sync (#862「同步 job 自动启动」). */
  sync: LotterySyncTrigger;
}

/**
 * 库存感知的权重抽取（#865）：跳过零库存实物档后按权重重新归一化抽取；
 * 实物档全空（或池里只剩兜底）时落「谢谢参与」兜底档（永不售罄）。
 * `randomInt(maxExclusive)` 注入以便确定性测试。
 */
export function pickWeightedPrize(prizes: LotteryPrizeRow[], randomInt: (maxExclusive: number) => number): LotteryPrizeRow {
  const fallback = prizes.find((prize) => prize.isFallback);
  const drawable = prizes.filter((prize) => !prize.isFallback && prize.remaining > 0);
  if (drawable.length === 0) {
    if (fallback === undefined) {
      throw new Error("prize pool has no fallback tier");
    }
    return fallback;
  }
  const totalWeight = drawable.reduce((sum, prize) => sum + prize.weight, 0);
  let roll = randomInt(totalWeight);
  for (const prize of drawable) {
    roll -= prize.weight;
    if (roll < 0) return prize;
  }
  // randomInt(totalWeight) < totalWeight，游标必然在循环内命中；到达这里是
  // 不变量破坏，按无兜底档处理。
  throw new Error("prize pool has no fallback tier");
}

/**
 * 活动内 000-999 随机取一个未占用编号（补零 3 位）。码空间全满返回 null
 * ——配置层已强校验总库存 ≤ 999（#862 决策5），这是防御分支。
 */
export function pickFreeCode(occupied: ReadonlySet<string>, randomInt: (maxExclusive: number) => number): string | null {
  const free: string[] = [];
  for (let n = 0; n <= MAX_TOTAL_STOCK; n++) {
    const code = n.toString().padStart(3, "0");
    if (!occupied.has(code)) free.push(code);
  }
  if (free.length === 0) return null;
  return free[randomInt(free.length)] ?? null;
}

async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Admin activity + prize-pool CRUD; every route requires a verified admin token. */
export function registerLotteryAdminRoutes(app: Hono<AuthEnv>, dependencies: LotteryRouteDeps & { auth: MiddlewareHandler<AuthEnv> }): void {
  const admin = createAdminMiddleware();
  const store = dependencies.store;

  app.post("/api/admin/lottery/activities", dependencies.auth, admin, async (context) => {
    const body = await readJsonBody(context.req.raw);
    if (body === null) return context.json({ error: "invalid_json" }, 400);
    const parsed = parseActivityRequest(body);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const windowError = timeWindowError(parsed.value);
    if (windowError !== undefined) return context.json({ error: windowError }, 422);
    const created = await store.createActivity(parsed.value);
    return context.json(activityResponse(created), 201);
  });

  app.get("/api/admin/lottery/activities", dependencies.auth, admin, async (context) => {
    const activities = await store.listActivities();
    return context.json({ activities: activities.map(activityResponse) });
  });

  app.get("/api/admin/lottery/activities/:id", dependencies.auth, admin, async (context) => {
    const id = activityIdParam(context);
    if (id === null) return context.json({ error: "invalid_activity_id" }, 400);
    const activity = await store.getActivity(id);
    if (activity === null) return context.json({ error: "activity_not_found" }, 404);
    const prizes = await store.listPrizes(id);
    return context.json({ ...activityResponse(activity), prizes: prizes.map(prizeResponse) });
  });

  app.put("/api/admin/lottery/activities/:id", dependencies.auth, admin, async (context) => {
    const id = activityIdParam(context);
    if (id === null) return context.json({ error: "invalid_activity_id" }, 400);
    const body = await readJsonBody(context.req.raw);
    if (body === null) return context.json({ error: "invalid_json" }, 400);
    const parsed = parseActivityRequest(body);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const windowError = timeWindowError(parsed.value);
    if (windowError !== undefined) return context.json({ error: windowError }, 422);
    const updated = await store.updateActivity(id, parsed.value);
    if (updated === null) return context.json({ error: "activity_not_found" }, 404);
    return context.json(activityResponse(updated));
  });

  app.put("/api/admin/lottery/activities/:id/prizes", dependencies.auth, admin, async (context) => {
    const id = activityIdParam(context);
    if (id === null) return context.json({ error: "invalid_activity_id" }, 400);
    if (!(await store.getActivity(id))) return context.json({ error: "activity_not_found" }, 404);
    const body = await readJsonBody(context.req.raw);
    if (body === null) return context.json({ error: "invalid_json" }, 400);
    const parsed = parsePrizesRequest(body);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const configError = prizeConfigError(parsed.value);
    if (configError !== undefined) return context.json({ error: configError }, 422);
    // 换奖池会让既有中奖编号失去指向：已有参与记录（P2 起写）后禁止整池替换。
    if (await store.hasParticipations(id)) return context.json({ error: "activity_has_participations" }, 409);
    const prizes = await store.replacePrizes(id, parsed.value);
    return context.json({ prizes: prizes.map(prizeResponse) });
  });

  for (const [path, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    app.post(`/api/admin/lottery/activities/:id/${path}`, dependencies.auth, admin, async (context) => {
      const id = activityIdParam(context);
      if (id === null) return context.json({ error: "invalid_activity_id" }, 400);
      const updated = await store.setActivityEnabled(id, enabled);
      if (updated === null) return context.json({ error: "activity_not_found" }, 404);
      return context.json(activityResponse(updated));
    });
  }
}

/**
 * GET /api/lottery/activities/:id — 免登录公开端点（落地页）。
 * 200 展示数据（档位名/图/剩余库存/规则文案/时间窗状态）；404 不存在或未启用。
 * 绝不返回权重/配置库存等内部字段。
 */
export function registerLotteryPublicRoute(app: Hono<AuthEnv>, dependencies: LotteryRouteDeps): void {
  app.get("/api/lottery/activities/:id", async (context) => {
    const id = activityIdParam(context);
    if (id === null) return context.json({ error: "not_found" }, 404);
    const activity = await dependencies.store.getActivity(id);
    if (activity === null || !activity.enabled) {
      return context.json({ error: "not_found" }, 404);
    }
    const prizes = await dependencies.store.listPrizes(id);
    return context.json({
      id: activity.id,
      name: activity.name,
      hero_image: activity.heroImage,
      rules_text: activity.rulesText,
      start_at: activity.startAt.toISOString(),
      end_at: activity.endAt.toISOString(),
      status: lotteryPhase(activity.startAt, activity.endAt),
      prizes: prizes.map((prize) => ({
        name: prize.name,
        image_url: prize.imageUrl,
        // 兜底档无库存概念（永不售罄），remaining 为 null；其余档位为当前可抽库存。
        remaining: prize.isFallback ? null : prize.remaining,
        is_fallback: prize.isFallback,
      })),
    });
  });
}

function drawResultResponse(result: DrawOutcome & { outcome: "created" | "duplicate" }): Record<string, unknown> {
  const participation = result.participation;
  return {
    participated: true,
    deduplicated: result.outcome === "duplicate",
    prize: result.prize === null ? null : prizeView(result.prize),
    // 3 位补零编号；「谢谢参与」无编号。
    code: participation.code,
    status: participation.status,
    created_at: participation.createdAt.toISOString(),
  };
}

function myResultResponse(participation: LotteryParticipationRow, prize: LotteryPrizeRow | null): Record<string, unknown> {
  return {
    participated: true,
    prize: prize === null ? null : prizeView(prize),
    code: participation.code,
    status: participation.status,
    verified_at: participation.verifiedAt === null ? null : participation.verifiedAt.toISOString(),
    created_at: participation.createdAt.toISOString(),
  };
}

/** Result payloads never expose weights or configured stock. */
function prizeView(prize: LotteryPrizeRow): Record<string, unknown> {
  return { name: prize.name, image_url: prize.imageUrl, is_fallback: prize.isFallback };
}

/**
 * 抽奖核心（#865）：
 *   POST /api/lottery/activities/:id/draw — 服务端硬校验（时间窗/登录态/绑表）
 *   → 事务内库存感知权重抽取 + 行锁扣库存 + 3 位编号分配。
 *   201 首次开奖；200 重复参与（唯一约束兜底，返回已有结果）；409 同一手表
 *   账号已抽过；403 时间窗外 / 手表未绑定。开奖成功即后台 fail-soft 触发全量同步。
 *   GET /api/lottery/activities/:id/my-result — 参与记录 + 奖品 + 编号 + 核销状态；
 *   未参与返回 participated:false（落地页预取渲染结果态用）。
 */
export function registerLotteryDrawRoutes(app: Hono<AuthEnv>, dependencies: LotteryDrawRouteDeps & { auth: MiddlewareHandler<AuthEnv> }): void {
  const { store, watch, sync } = dependencies;

  app.post("/api/lottery/activities/:id/draw", dependencies.auth, async (context) => {
    const id = activityIdParam(context);
    if (id === null) return context.json({ error: "invalid_activity_id" }, 400);
    const userId = context.get("userId");

    // 硬校验 1：活动存在且已启用——与公开端点同口径（未启用 == 不存在）。
    const activity = await store.getActivity(id);
    if (activity === null || !activity.enabled) {
      return context.json({ error: "not_found" }, 404);
    }
    // 硬校验 2：时间窗（起点即进行中，终点仍进行中，与 lotteryPhase 边界一致）。
    const phase = lotteryPhase(activity.startAt, activity.endAt);
    if (phase !== "active") {
      return context.json({ error: "activity_not_active", phase }, 403);
    }
    // 硬校验 3：手表已绑定且已登录（logged_in 语义，服务端自查，不信客户端）。
    const watchCredential = await watch.getLoggedInWatch(userId);
    if (watchCredential === null) {
      return context.json({ error: "watch_not_bound" }, 403);
    }

    const result = await store.drawParticipation({
      activityId: id,
      userId,
      providerKey: watchCredential.providerKey,
      allocate: (prizes, occupiedCodes) => {
        const prize = pickWeightedPrize(prizes, randomInt);
        const code = prize.isFallback ? null : pickFreeCode(occupiedCodes, randomInt);
        return { prize, code };
      },
    });
    if (result.outcome === "provider_conflict") {
      return context.json({ error: "watch_already_drawn" }, 409);
    }
    // fire-and-forget：抽奖结果已定，同步触发失败只记日志（fail-soft 契约）。
    // 仅首次开奖触发——重放返回已有结果时，首轮已触发过（幂等键兜底重复）。
    if (result.outcome === "created") {
      void sync.triggerFullSyncIfNewUser(id, userId);
    }
    return context.json(drawResultResponse(result), result.outcome === "created" ? 201 : 200);
  });

  app.get("/api/lottery/activities/:id/my-result", dependencies.auth, async (context) => {
    const id = activityIdParam(context);
    if (id === null) return context.json({ error: "invalid_activity_id" }, 400);
    const participation = await store.getParticipation(id, context.get("userId"));
    if (participation === null) {
      return context.json({ participated: false });
    }
    const prize = participation.prizeId === null ? null : await store.getPrize(participation.prizeId);
    return context.json(myResultResponse(participation, prize));
  });
}

// ── #866 核销域 ─────────────────────────────────────────────────────────

/** 中奖编号固定 3 位数字（000-999，补零展示）。 */
const WINNING_CODE_RE = /^\d{3}$/;
/** wx.login code：非空、有上限（正常 32 位）即可，形状由 auth-service 校验。 */
const MAX_WX_CODE_CHARS = 128;
/** 防爆破（#866）：3 位码空间仅 1000，查询+核销合并按 openid 每分钟 30 次。 */
const VERIFY_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export interface LotteryVerifyRouteDeps {
  store: LotteryStore;
  /** wx.login code → openid（auth-service 内部端点）。未配置时核销域整体 503。 */
  openid?: LotteryOpenidResolver;
}

interface VerifyRequestBody {
  code: string;
  wxCode: string;
}

function parseVerifyRequest(body: unknown): { ok: true; value: VerifyRequestBody } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "invalid_request" };
  const code = body.code;
  if (typeof code !== "string" || !WINNING_CODE_RE.test(code)) return { ok: false, error: "invalid_code" };
  const wxCode = body.wx_code;
  if (typeof wxCode !== "string" || wxCode.length === 0 || wxCode.length > MAX_WX_CODE_CHARS) {
    return { ok: false, error: "invalid_wx_code" };
  }
  return { ok: true, value: { code, wxCode } };
}

function verifyEntryResponse(participation: LotteryParticipationRow, prize: LotteryPrizeRow): Record<string, unknown> {
  return {
    code: participation.code,
    status: participation.status,
    prize: prizeView(prize),
    won_at: participation.createdAt.toISOString(),
    verified_at: participation.verifiedAt === null ? null : participation.verifiedAt.toISOString(),
    verified_by: participation.verifiedBy,
  };
}

/**
 * 核销域（#866）：现场工作人员在小程序核销页凭 3 位中奖编号核对并核销。
 *
 *   POST /api/lottery/activities/:id/verify/lookup — 查询中奖详情
 *   POST /api/lottery/activities/:id/verify/redeem  — 核销（待核销→已核销）
 *
 * 鉴权链（顺序固定）：登录 JWT → wx.login code 换 openid（未配置/上游失败
 * 503）→ 活动存在且启用（404，与公开端点同口径）→ staff 白名单（未命中 403
 * 且响应体带回请求者自己的 openid 供小程序展示+复制，后台添加后即可用）→
 * 按 openid 限速（429，查询与核销共享预算）→ 落库操作。每次查询与核销均
 * 全量留痕（lottery_verification_logs）。时间窗不设限：兑奖常在开奖窗结束
 * 后继续，enabled 是唯一开关。
 */
export function registerLotteryVerifyRoutes(app: Hono<AuthEnv>, dependencies: LotteryVerifyRouteDeps & { auth: MiddlewareHandler<AuthEnv> }): void {
  const { store } = dependencies;
  const limiter = new IpRateLimiter(VERIFY_RATE_LIMIT);

  for (const [path, action] of [["verify/lookup", "lookup"] as const, ["verify/redeem", "redeem"] as const]) {
    app.post(`/api/lottery/activities/:id/${path}`, dependencies.auth, async (context) => {
      const id = activityIdParam(context);
      if (id === null) return context.json({ error: "invalid_activity_id" }, 400);
      const body = await readJsonBody(context.req.raw);
      if (body === null) return context.json({ error: "invalid_json" }, 400);
      const parsed = parseVerifyRequest(body);
      if (!parsed.ok) return context.json({ error: parsed.error }, 400);

      // wx code 一次性：先完成全部结构校验再消费它。
      const resolver = dependencies.openid;
      if (resolver === undefined) {
        return context.json({ error: "verify_openid_unavailable" }, 503);
      }
      const resolution = await resolver.resolve(parsed.value.wxCode);
      if (resolution.status === "unavailable") {
        return context.json({ error: "verify_openid_unavailable" }, 503);
      }

      const activity = await store.getActivity(id);
      if (activity === null || !activity.enabled) {
        return context.json({ error: "not_found" }, 404);
      }

      if (!(await store.isStaffOpenid(resolution.openid, id))) {
        // 回显请求者自己的 openid：页面展示+复制，后台加白后刷新可用。
        return context.json({ error: "not_staff", openid: resolution.openid }, 403);
      }

      if (!limiter.allow(resolution.openid)) {
        return context.json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
      }

      if (action === "lookup") {
        const participation = await store.findWinningByCode({
          activityId: id,
          openid: resolution.openid,
          code: parsed.value.code,
        });
        if (participation === null) {
          // 「谢谢参与」不占编号：编号只存在于中奖记录，查无即明确语义。
          return context.json({ error: "code_not_found" }, 404);
        }
        const prize = participation.prizeId === null ? null : await store.getPrize(participation.prizeId);
        if (prize === null) {
          throw new Error(`lottery verify lookup: prize ${participation.prizeId} missing for participation ${participation.id}`);
        }
        return context.json(verifyEntryResponse(participation, prize));
      }

      const result = await store.redeemParticipation({
        activityId: id,
        code: parsed.value.code,
        verifiedBy: resolution.openid,
        verifiedAt: new Date(),
      });
      if (result.outcome === "not_found") {
        return context.json({ error: "code_not_found" }, 404);
      }
      const prize = result.participation.prizeId === null ? null : await store.getPrize(result.participation.prizeId);
      if (prize === null) {
        throw new Error(`lottery verify redeem: prize missing for participation ${result.participation.id}`);
      }
      return context.json({ ...verifyEntryResponse(result.participation, prize), already_verified: result.outcome === "already_verified" });
    });
  }
}
