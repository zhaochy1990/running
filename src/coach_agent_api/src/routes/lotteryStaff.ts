/**
 * Admin staff-whitelist routes (#867; the P3 verification page is the reader).
 *
 * 运营在这里维护核销工作白名单：全局行（activity_id NULL，任意活动可核销）
 * 或活动级行。增删查全部 admin 双门（auth + admin），与其他 admin lottery
 * 端点同口径。删除按行 id；openid 由现场工作人员在小程序核销页未命中提示
 * 里复制回来（后端响应带回请求者自己的 openid，见 P3）。
 */
import type { Hono, MiddlewareHandler } from "hono";
import { type AuthEnv, createAdminMiddleware } from "../auth.js";
import type { LotteryStaffInput, LotteryStaffRow, LotteryStaffStore } from "../persistence/lotteryStaff.js";

const MAX_OPENID_CHARS = 128;
const MAX_NOTE_CHARS = 255;
const ACTIVITY_ID_RE = /^\d{1,15}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Staff body: `{ openid, activity_id?, note? }`. Structural problems are
 * error codes (400). The activity need not exist yet — a whitelist row may be
 * staged before the activity is published, and its lifecycle is the admin's.
 */
export function parseStaffRequest(body: unknown): { ok: true; value: LotteryStaffInput } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "invalid_request" };
  const openid = typeof body.openid === "string" ? body.openid.trim() : "";
  if (openid.length === 0 || openid.length > MAX_OPENID_CHARS) return { ok: false, error: "invalid_openid" };

  let activityId: number | undefined;
  if (body.activity_id !== undefined && body.activity_id !== null) {
    if (typeof body.activity_id !== "number" || !Number.isInteger(body.activity_id) || body.activity_id <= 0) {
      return { ok: false, error: "invalid_activity_id" };
    }
    activityId = body.activity_id;
  }

  const noteRaw = body.note;
  let note: string | undefined;
  if (noteRaw !== undefined && noteRaw !== null) {
    if (typeof noteRaw !== "string" || noteRaw.length > MAX_NOTE_CHARS) return { ok: false, error: "invalid_note" };
    note = noteRaw.length === 0 ? undefined : noteRaw;
  }
  return { ok: true, value: { openid, ...(activityId !== undefined ? { activityId } : {}), ...(note !== undefined ? { note } : {}) } };
}

function staffResponse(row: LotteryStaffRow): Record<string, unknown> {
  return {
    id: row.id,
    openid: row.openid,
    activity_id: row.activityId,
    note: row.note,
    created_at: row.createdAt.toISOString(),
  };
}

export interface LotteryStaffRouteDeps {
  store: LotteryStaffStore;
  auth: MiddlewareHandler<AuthEnv>;
}

/** Staff whitelist management; every route requires a verified admin token. */
export function registerLotteryStaffRoutes(app: Hono<AuthEnv>, dependencies: LotteryStaffRouteDeps): void {
  const admin = createAdminMiddleware();
  const store = dependencies.store;

  app.get("/api/admin/lottery/staff", dependencies.auth, admin, async (context) => {
    const raw = context.req.query("activity_id");
    if (raw !== undefined && raw !== "" && !ACTIVITY_ID_RE.test(raw)) {
      return context.json({ error: "invalid_activity_id" }, 400);
    }
    const staff = await store.listStaff(raw === undefined || raw === "" ? undefined : Number(raw));
    return context.json({ staff: staff.map(staffResponse) });
  });

  app.post("/api/admin/lottery/staff", dependencies.auth, admin, async (context) => {
    let body: unknown;
    try {
      body = await context.req.raw.json();
    } catch {
      return context.json({ error: "invalid_json" }, 400);
    }
    const parsed = parseStaffRequest(body);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const created = await store.addStaff(parsed.value);
    return context.json(staffResponse(created), 201);
  });

  app.delete("/api/admin/lottery/staff/:id", dependencies.auth, admin, async (context) => {
    const raw = context.req.param("id") ?? "";
    if (!/^\d{1,15}$/.test(raw)) return context.json({ error: "invalid_staff_id" }, 400);
    const removed = await store.removeStaff(Number(raw));
    if (!removed) return context.json({ error: "staff_not_found" }, 404);
    return context.body(null, 204);
  });
}
