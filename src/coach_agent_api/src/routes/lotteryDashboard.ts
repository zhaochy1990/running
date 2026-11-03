/**
 * Lottery dashboard routes (#867 数据看板; epic #862).
 *
 *   GET  /api/admin/lottery/activities/:id/funnel — admin-only. One call for
 *        the live 看板: the participation funnel grouped by 点位渠道号 (scene
 *        `s` param), stage totals, and per-tier remaining stock. Pre-draw
 *        stages (进入/登录/绑表) are ping 次数 from the event log; post-draw
 *        stages (抽奖/中奖/核销) are 人数 from lottery_participations —
 *        verified counts committed redemptions via verified_at, whatever
 *        status literal the P3 verify domain writes.
 *
 *   POST /api/lottery/activities/:id/events — public funnel ping from the
 *        mini-program landing page (stage enter/login/bind). Fire-and-forget
 *        analytics, best-effort user attribution when a bearer is present,
 *        and an in-memory per-IP fixed-window limiter so the unauthenticated
 *        surface cannot flood the log. The mini-program ignores the outcome.
 */
import type { Hono, MiddlewareHandler } from "hono";
import { type AuthEnv, createAdminMiddleware } from "../auth.js";
import type { LotteryStore } from "../persistence/lottery.js";
import { LOTTERY_EVENT_STAGES, type LotteryEventStage, type LotteryFunnelSceneRow, type LotteryFunnelStore } from "../persistence/lotteryFunnel.js";
import { SCENE_VALUE_RE } from "./lottery.js";

/** 每 IP+活动每固定窗口允许的埋点 ping 数。正常单用户整场活动 < 10 次。 */
const EVENT_RATE_LIMIT = 60;
const EVENT_WINDOW_MS = 60_000;
/** 防御性上限：key 数（IP×活动）超过它就先清扫过期窗口再放行。 */
const MAX_BUCKETS = 10_000;

const ACTIVITY_ID_RE = /^\d{1,15}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activityIdParam(context: { req: { param(name: string): string | undefined } }): number | null {
  const raw = context.req.param("id") ?? "";
  if (!ACTIVITY_ID_RE.test(raw)) return null;
  return Number(raw);
}

/** 固定窗口限速（单实例内存版——多副本部署下各副本各限一份，够用）。 */
function allowEventPing(key: string, now = Date.now()): boolean {
  if (buckets.size > MAX_BUCKETS) {
    for (const [k, bucket] of buckets) {
      if (now - bucket.windowStart >= EVENT_WINDOW_MS) buckets.delete(k);
    }
  }
  let bucket = buckets.get(key);
  if (bucket === undefined || now - bucket.windowStart >= EVENT_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    buckets.set(key, bucket);
  }
  if (bucket.count >= EVENT_RATE_LIMIT) return false;
  bucket.count += 1;
  return true;
}
const buckets = new Map<string, { windowStart: number; count: number }>();

function parseEventRequest(body: unknown): { ok: true; value: { stage: LotteryEventStage; scene: string | null } } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "invalid_request" };
  const stage = body.stage;
  if (typeof stage !== "string" || !(LOTTERY_EVENT_STAGES as readonly string[]).includes(stage)) {
    return { ok: false, error: "invalid_stage" };
  }
  const sceneRaw = body.scene;
  if (sceneRaw === undefined || sceneRaw === null) {
    return { ok: true, value: { stage: stage as LotteryEventStage, scene: null } };
  }
  if (typeof sceneRaw !== "string" || !SCENE_VALUE_RE.test(sceneRaw)) {
    return { ok: false, error: "invalid_scene" };
  }
  return { ok: true, value: { stage: stage as LotteryEventStage, scene: sceneRaw } };
}

function clientIp(context: { req: { header(name: string): string | undefined } }): string {
  const forwarded = context.req.header("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first ?? "unknown";
}

function funnelSceneResponse(row: LotteryFunnelSceneRow): Record<string, unknown> {
  return { scene: row.scene, enter: row.enter, login: row.login, bind: row.bind, draw: row.draw, win: row.win, verified: row.verified };
}

export interface LotteryDashboardRouteDeps {
  store: LotteryStore;
  events: LotteryFunnelStore;
  auth: MiddlewareHandler<AuthEnv>;
  /** 可选鉴权：埋点 ping 带 token 时归因到用户，不带则匿名。 */
  optionalAuth: MiddlewareHandler<AuthEnv>;
}

export function registerLotteryDashboardRoutes(app: Hono<AuthEnv>, dependencies: LotteryDashboardRouteDeps): void {
  const admin = createAdminMiddleware();
  const { store, events } = dependencies;

  app.get("/api/admin/lottery/activities/:id/funnel", dependencies.auth, admin, async (context) => {
    const id = activityIdParam(context);
    if (id === null) return context.json({ error: "invalid_activity_id" }, 400);
    const activity = await store.getActivity(id);
    if (activity === null) return context.json({ error: "activity_not_found" }, 404);

    const scenes = await events.funnelByScene(id);
    const totals = scenes.reduce(
      (sum, row) => ({
        enter: sum.enter + row.enter,
        login: sum.login + row.login,
        bind: sum.bind + row.bind,
        draw: sum.draw + row.draw,
        win: sum.win + row.win,
        verified: sum.verified + row.verified,
      }),
      { enter: 0, login: 0, bind: 0, draw: 0, win: 0, verified: 0 },
    );
    const prizes = await store.listPrizes(id);
    return context.json({
      activity: {
        id: activity.id,
        name: activity.name,
        start_at: activity.startAt.toISOString(),
        end_at: activity.endAt.toISOString(),
        enabled: activity.enabled,
      },
      scenes: scenes.map(funnelSceneResponse),
      totals,
      prizes: prizes.map((prize) => ({
        name: prize.name,
        image_url: prize.imageUrl,
        stock: prize.stock,
        remaining: prize.remaining,
        is_fallback: prize.isFallback,
      })),
    });
  });

  app.post("/api/lottery/activities/:id/events", dependencies.optionalAuth, async (context) => {
    const id = activityIdParam(context);
    if (id === null) return context.json({ error: "invalid_activity_id" }, 400);
    if (!(await store.getActivity(id))) return context.json({ error: "activity_not_found" }, 404);

    let body: unknown;
    try {
      body = await context.req.raw.json();
    } catch {
      return context.json({ error: "invalid_json" }, 400);
    }
    const parsed = parseEventRequest(body);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    if (!allowEventPing(`${clientIp(context)}:${id}`)) {
      return context.json({ error: "rate_limited" }, 429);
    }
    await events.recordEvent({ activityId: id, stage: parsed.value.stage, scene: parsed.value.scene, userId: context.get("userId") ?? null });
    return context.body(null, 204);
  });
}
