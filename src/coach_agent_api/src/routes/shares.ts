/**
 * Coach chat share endpoints (#715).
 *
 * Create (`POST /api/users/me/coach/sessions/:sessionId/share`) lives inside
 * the existing `/api/users/me/coach/sessions/*` auth prefix — zero new auth
 * work. The caller names projection indices only: the server re-projects the
 * thread from its checkpoint (toPublicHistory) and extracts the selected
 * messages itself, so coach content can't be forged by a crafted body.
 *
 * Read (`GET /api/coach-shares/:sid`) is public (registered next to /health,
 * outside every auth prefix) and serves the immutable snapshot: no checkpoint
 * access, 30-day expiry computed at read time (410), a light in-process
 * per-IP rate limit (#622), and a wxacode URL generated fail-soft — a wxacode
 * failure never blocks share creation.
 */
import { createHash, randomBytes } from "node:crypto";
import { getLogger } from "@stride/common";
import type { Hono } from "hono";
import type { AuthEnv } from "../auth.js";
import type { CoachShareStore } from "../persistence/shares.js";
import { type SessionHistoryMessage, toPublicHistory } from "../publicResponse.js";
import { SESSION_ID_RE, type ThreadHistoryReader } from "./history.js";

const logger = getLogger("coachShares");

/** sid 形状即访问边界：非法 sid 一律 404，不落库、不计频控。 */
export const SHARE_SID_RE = /^[A-Za-z0-9]{16,22}$/;

const MAX_SELECTED_MESSAGES = 30;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_SHARER_NAME_CHARS = 64;
/** #622 定稿：30 天过期不可撤销，读取时计算。 */
const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** #622 轻量频控口径：每分钟每 IP 60 次。 */
const SHARE_READ_RATE_LIMIT = { limit: 60, windowMs: 60_000 };

const textEncoder = new TextEncoder();

function byteLength(value: string): number {
  return textEncoder.encode(value).length;
}

/**
 * 22 位 base62 随机 sid（≈131 bit，不可枚举，#625 scene ≤32 可见字符约束内）。
 * 每字符拒绝采样（< 248 才取模），分布无偏。
 */
export function generateShareSid(): string {
  const base62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let sid = "";
  while (sid.length < 22) {
    for (const byte of randomBytes(32)) {
      if (byte < 248) {
        sid += base62[byte % 62];
        if (sid.length === 22) break;
      }
    }
  }
  return sid;
}

/** 选集指纹：sha256(升序去重后的投影序号串)，uk_selection 的第三列。
 *  在此规范化（而非依赖调用方），不同顺序的同一选集必然同一分享。 */
export function selectionHash(indices: number[]): string {
  const canonical = [...new Set(indices)].sort((a, b) => a - b);
  return createHash("sha256").update(canonical.join(",")).digest("hex");
}

/** strategy_refs 三元组来源：race_event_id 已随卡片 data 持久化（render #715 扩展）；
 *  version_id 是「应用」后 Go race_strategy 行 id，生成期不存在，快照里落 null，
 *  阅读端据此降级（无版本则不给 #506 跳转）。 */
export interface StrategyRef {
  user_id: string;
  race_id: number | null;
  version_id: number | null;
  message_index: number;
}

export function extractStrategyRefs(userId: string, messages: SessionHistoryMessage[]): StrategyRef[] {
  const refs: StrategyRef[] = [];
  for (const [index, message] of messages.entries()) {
    const card = message.card;
    if (message.role !== "assistant" || card === undefined || card.$type !== "race-strategy") continue;
    const data = typeof card.data === "object" && card.data !== null ? (card.data as Record<string, unknown>) : {};
    refs.push({
      user_id: userId,
      race_id: positiveInt(data.race_event_id),
      version_id: positiveInt(data.version_id),
      message_index: index,
    });
  }
  return refs;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 体积口径（#621）：单条 ≤64KB、快照总体 ≤2MB，超限返回给用户的中文提示，
 * 通过则 undefined。（30 条 × 64KB < 2MB，总上限平时为纵深防御——payload
 * 结构膨胀或未来上限调整时兜底。）
 */
export function shareSizeError(indices: number[], selected: SessionHistoryMessage[], payload: Record<string, unknown>): string | undefined {
  const oversized = selected.findIndex((message) => byteLength(JSON.stringify(message)) > MAX_MESSAGE_BYTES);
  if (oversized >= 0) {
    return `第 ${(indices[oversized] ?? 0) + 1} 条消息超过单条上限（64KB），无法分享`;
  }
  if (byteLength(JSON.stringify(payload)) > MAX_TOTAL_BYTES) {
    return "分享内容超过总体积上限（2MB），请减少所选消息";
  }
  return undefined;
}

/**
 * wxacode 生成端口（auth 仓 #714 端点）。失败一律返回 null——分享创建永不
 * 被它挡住（fail-soft 是 #715 的硬约束）。
 */
export interface WxacodeClient {
  generate(scene: string): Promise<string | null>;
}

export class AuthWxacodeClient implements WxacodeClient {
  constructor(private readonly options: { baseUrl: string; internalToken: string; page: string; envVersion: "trial" | "develop" | "release" }) {}

  async generate(scene: string): Promise<string | null> {
    try {
      const response = await fetch(new URL("/api/internal/wxacode", this.options.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "X-Internal-Token": this.options.internalToken },
        // check_path=false + trial：check_path 前的开发期口径，上线后切 release。
        body: JSON.stringify({ scene, page: this.options.page, env_version: this.options.envVersion, check_path: false }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        logger.warn({ status: response.status, sceneLength: scene.length }, "wxacode endpoint returned an error");
        return null;
      }
      const body = (await response.json()) as { url?: unknown };
      if (typeof body.url !== "string" || !body.url.startsWith("https://")) {
        logger.warn({ sceneLength: scene.length }, "wxacode endpoint returned no usable url");
        return null;
      }
      return body.url;
    } catch (error) {
      logger.warn({ err: error, sceneLength: scene.length }, "wxacode generation failed (fail-soft, share kept)");
      return null;
    }
  }
}

export interface CoachShareCreateDeps {
  store: CoachShareStore;
  checkpointer: ThreadHistoryReader;
  wxacode?: WxacodeClient;
}

/**
 * POST /api/users/me/coach/sessions/{session_id}/share.
 * 服务端抽取 + 快照落库；同选集（user, session, selection_hash）幂等复用既有
 * sid（reused:true）。422 表策略性超限（条数/体积，中文提示），400 表结构或
 * 序号非法。
 */
export function registerShareCreateRoute(app: Hono<AuthEnv>, dependencies: CoachShareCreateDeps): void {
  app.post("/api/users/me/coach/sessions/:sessionId/share", async (context) => {
    const userId = context.get("userId");
    const sessionId = context.req.param("sessionId");
    if (!SESSION_ID_RE.test(sessionId)) {
      return context.json({ error: "invalid_session_id" }, 400);
    }

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_json" }, 400);
    }
    const parsed = parseShareRequest(body);
    if (typeof parsed === "string") {
      return context.json({ error: parsed }, 400);
    }
    if (parsed.indices.length > MAX_SELECTED_MESSAGES) {
      return context.json({ error: `最多分享 ${MAX_SELECTED_MESSAGES} 条消息，当前选了 ${parsed.indices.length} 条` }, 422);
    }

    const tuple = await dependencies.checkpointer.getTuple({ configurable: { thread_id: `${userId}:coach:${sessionId}` } });
    const channelValues = tuple?.checkpoint?.channel_values ?? {};
    const rawMessages = (channelValues as { messages?: unknown[] }).messages ?? [];
    const history = toPublicHistory(Array.isArray(rawMessages) ? rawMessages : []);
    if (history.length === 0) {
      return context.json({ error: "session_not_found" }, 404);
    }
    if (parsed.indices.some((index) => index >= history.length)) {
      return context.json({ error: "invalid_indices" }, 400);
    }

    const selected: SessionHistoryMessage[] = [];
    for (const index of parsed.indices) {
      const message = history[index];
      // parseShareRequest 之后历史不会变长，此分支不可达；防御投影层收缩。
      if (message === undefined) {
        return context.json({ error: "invalid_indices" }, 400);
      }
      selected.push(message);
    }

    const payload: Record<string, unknown> = {
      messages: selected,
      strategy_refs: extractStrategyRefs(userId, selected),
      ...(parsed.sharerName !== undefined ? { sharer_name: parsed.sharerName } : {}),
    };
    const oversize = shareSizeError(parsed.indices, selected, payload);
    if (oversize !== undefined) {
      return context.json({ error: oversize }, 422);
    }

    const { sid, reused, wxacodeUrl } = await dependencies.store.createOrGet({
      sid: generateShareSid(),
      userId,
      sessionId,
      selectionHash: selectionHash(parsed.indices),
      messageCount: selected.length,
      payload,
      totalBytes: byteLength(JSON.stringify(payload)),
    });
    const url = await ensureWxacode(dependencies, sid, wxacodeUrl);
    return context.json({ sid, reused, wxacode_url: url }, reused ? 200 : 201);
  });
}

async function ensureWxacode(dependencies: CoachShareCreateDeps, sid: string, existing: string | null): Promise<string | null> {
  if (existing !== null) return existing;
  const wxacode = dependencies.wxacode;
  if (wxacode === undefined) return null;
  const url = await wxacode.generate(sid);
  if (url === null) return null;
  await dependencies.store.setWxacodeUrl(sid, url);
  return url;
}

interface ShareRequest {
  indices: number[];
  sharerName?: string;
}

/** Structural validation only; limits (count/size) are 422s in the route. */
function parseShareRequest(body: unknown): ShareRequest | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "invalid_request";
  }
  const rawIndices = (body as { indices?: unknown }).indices;
  if (!Array.isArray(rawIndices) || rawIndices.length === 0) {
    return "invalid_indices";
  }
  for (const index of rawIndices) {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      return "invalid_indices";
    }
  }
  const sharerRaw = (body as { sharer_name?: unknown }).sharer_name;
  let sharerName: string | undefined;
  if (sharerRaw !== undefined) {
    if (typeof sharerRaw !== "string") return "invalid_sharer_name";
    sharerName = sharerRaw.trim();
    if (sharerName.length === 0) {
      sharerName = undefined;
    } else if (sharerName.length > MAX_SHARER_NAME_CHARS) {
      return "invalid_sharer_name";
    }
  }
  // 升序去重（序号串进 selection_hash，不同顺序的同一选集共享同一分享）。
  const indices = [...new Set(rawIndices as number[])].sort((a, b) => a - b);
  return { indices, ...(sharerName !== undefined ? { sharerName } : {}) };
}

export interface CoachShareReadDeps {
  store: CoachShareStore;
}

/**
 * GET /api/coach-shares/{sid} — 公开端点（免登录，网关 P3 放行该前缀）。
 * 200 快照 / 404 不存在（含非法 sid）/ 410 过期（expired）或非 active（gone）。
 * 非法 sid 在频控之前廉价拒绝：不落库、不占窗口。
 */
export function registerCoachShareReadRoute(app: Hono<AuthEnv>, dependencies: CoachShareReadDeps): void {
  const limiter = new IpRateLimiter(SHARE_READ_RATE_LIMIT);
  app.get("/api/coach-shares/:sid", async (context) => {
    const sid = context.req.param("sid");
    if (!SHARE_SID_RE.test(sid)) {
      return context.json({ error: "not_found" }, 404);
    }
    if (!limiter.allow(clientIp(context))) {
      return context.json({ error: "too_many_requests" }, 429, { "Retry-After": "60" });
    }
    const row = await dependencies.store.getBySid(sid);
    if (row === null) {
      return context.json({ error: "not_found" }, 404);
    }
    if (row.status !== "active") {
      // v1 无写入方（预留撤销位）；真出现时与过期分开表态。
      return context.json({ error: "gone" }, 410);
    }
    if (Date.now() >= row.createdAt.getTime() + SHARE_TTL_MS) {
      return context.json({ error: "expired" }, 410);
    }
    const sharerName = row.payload.sharer_name;
    return context.json({
      status: "active",
      ...(typeof sharerName === "string" && sharerName.length > 0 ? { sharer_name: sharerName } : {}),
      message_count: row.messageCount,
      created_at: row.createdAt.toISOString(),
      wxacode_url: row.wxacodeUrl,
      messages: Array.isArray(row.payload.messages) ? row.payload.messages : [],
    });
  });
}

/** 固定窗口计数器：单实例部署足够（#622「应用内频控即可」）；超阈值丢最旧窗口。 */
export class IpRateLimiter {
  private readonly windows = new Map<string, { window: number; count: number }>();

  constructor(private readonly options: { limit: number; windowMs: number }) {}

  allow(key: string, now = Date.now()): boolean {
    const window = Math.floor(now / this.options.windowMs);
    const entry = this.windows.get(key);
    if (entry === undefined || entry.window !== window) {
      if (this.windows.size >= 10_000) {
        this.sweep(window);
      }
      this.windows.set(key, { window, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.options.limit;
  }

  private sweep(currentWindow: number): void {
    for (const [key, entry] of this.windows) {
      if (entry.window !== currentWindow) this.windows.delete(key);
    }
  }
}

/** Caddy 网关注入 X-Forwarded-For（首跳为真实客户端）；本地直连退回 socket 地址。 */
function clientIp(context: { req: { header(name: string): string | undefined }; env: unknown }): string {
  const forwarded = context.req.header("x-forwarded-for");
  if (forwarded !== undefined && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  const incoming = (context.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}
