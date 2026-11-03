/**
 * Lottery activity configuration endpoints (#863, epic #862 P1).
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
 * total physical stock ≤ 999 — the 3-digit winning-code space the draw (P2)
 * allocates from.
 */
import type { Hono, MiddlewareHandler } from "hono";
import { type AuthEnv, createAdminMiddleware } from "../auth.js";
import type { LotteryActivityRow, LotteryPrizeRow, LotteryStore } from "../persistence/lottery.js";

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
