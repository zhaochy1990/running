import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import type { ThreadHistoryReader } from "../src/routes/history.js";
import {
  extractStrategyRefs,
  generateShareSid,
  selectionHash,
  SHARE_SID_RE,
  shareSizeError,
  type WxacodeClient,
} from "../src/routes/shares.js";
import type { CoachShareInsert, CoachShareRow, CoachShareStore } from "../src/persistence/shares.js";
import type { SessionHistoryMessage } from "../src/publicResponse.js";

/** streamEvents stub for tests that must never stream. */
const neverStream = () => {
  throw new Error("must not stream");
};

const jwtVerifier = {
  async verify() {
    return { userId: "athlete-1", isAdmin: false };
  },
};

/** 投影后 4 条：user / assistant / user / assistant(带 race-strategy 卡)。 */
const threadMessages = [
  { type: "human", content: JSON.stringify({ timestamp: "2026-10-23T10:00:00+08:00", message: "帮我制定杭州马策略" }) },
  { type: "ai", content: "好的，先确认目标成绩。" },
  { type: "human", content: JSON.stringify({ timestamp: "2026-10-23T10:01:00+08:00", message: "4 小时内" }) },
  {
    type: "ai",
    content: "策略如下……",
    additional_kwargs: { card: { $type: "race-strategy", data: { race_name: "杭州马拉松", race_event_id: 30 } } },
  },
  // 中间图步骤（带 tool_calls）——投影层丢弃，不占投影序号。
  { type: "ai", content: "思考中", tool_calls: [{ id: "t1" }] },
];

class FakeShareStore implements CoachShareStore {
  readonly rows = new Map<string, CoachShareRow>();

  async createOrGet(share: CoachShareInsert): Promise<{ sid: string; reused: boolean; wxacodeUrl: string | null }> {
    for (const row of this.rows.values()) {
      if (row.userId === share.userId && row.sessionId === share.sessionId && row.selectionHash === share.selectionHash) {
        return { sid: row.sid, reused: true, wxacodeUrl: row.wxacodeUrl };
      }
    }
    this.rows.set(share.sid, { ...share, wxacodeUrl: null, status: "active", createdAt: new Date() });
    return { sid: share.sid, reused: false, wxacodeUrl: null };
  }

  async getBySid(sid: string): Promise<CoachShareRow | null> {
    return this.rows.get(sid) ?? null;
  }

  async setWxacodeUrl(sid: string, url: string): Promise<void> {
    const row = this.rows.get(sid);
    if (row !== undefined) row.wxacodeUrl = url;
  }

  async setup(): Promise<void> {}

  /** 测试辅助：把某条分享弄旧（过期判定）。 */
  age(sid: string, milliseconds: number): void {
    const row = this.rows.get(sid);
    if (row !== undefined) row.createdAt = new Date(Date.now() - milliseconds);
  }
}

function checkpointerWith(messages: unknown[]): ThreadHistoryReader {
  return {
    async getTuple(config: { configurable: { thread_id: string } }) {
      if (config.configurable.thread_id !== "athlete-1:coach:session-1") return undefined;
      return { checkpoint: { channel_values: { messages } } } as never;
    },
  };
}

function shareApp(options: { messages?: unknown[]; store?: FakeShareStore; wxacode?: WxacodeClient } = {}) {
  return createApp({
    jwtVerifier,
    coachInvoker: {
      async invoke() {
        throw new Error("must not invoke");
      },
      streamEvents: neverStream,
    },
    checkpointer: checkpointerWith(options.messages ?? threadMessages),
    coachShares: {
      store: options.store ?? new FakeShareStore(),
      ...(options.wxacode !== undefined ? { wxacode: options.wxacode } : {}),
    },
  });
}

async function postShare(app: ReturnType<typeof createApp>, body: unknown, sessionId = "session-1"): Promise<Response> {
  return await app.request(`/api/users/me/coach/sessions/${sessionId}/share`, {
    method: "POST",
    headers: { authorization: "Bearer signed", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const wxacodeUrl = "https://cos.example.com/wxacode/abc.png";

function wxacodeClient(counter: { calls: number }, url: string | null = wxacodeUrl): WxacodeClient {
  return {
    async generate() {
      counter.calls += 1;
      return url;
    },
  };
}

test("sid 生成器：22 位 base62、大量生成不重复", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i += 1) {
    const sid = generateShareSid();
    assert.match(sid, SHARE_SID_RE);
    seen.add(sid);
  }
  assert.equal(seen.size, 1000);
});

test("selectionHash：升序序号串，与输入顺序无关", () => {
  assert.equal(selectionHash([1, 2, 3]), selectionHash([3, 1, 2]));
  assert.notEqual(selectionHash([1, 2]), selectionHash([1, 3]));
  assert.match(selectionHash([0, 3]), /^[0-9a-f]{64}$/);
});

test("创建→公开读取往返一致（服务端抽取，卡片随行）", async () => {
  const app = shareApp();
  const created = await postShare(app, { indices: [0, 3], sharer_name: "小赵" });
  assert.equal(created.status, 201);
  const body = (await created.json()) as { sid: string; reused: boolean; wxacode_url: string | null };
  assert.equal(body.reused, false);
  assert.match(body.sid, SHARE_SID_RE);
  assert.equal(body.wxacode_url, null);

  const read = await app.request(`/api/coach-shares/${body.sid}`);
  assert.equal(read.status, 200);
  const share = (await read.json()) as Record<string, unknown>;
  assert.equal(share.status, "active");
  assert.equal(share.sharer_name, "小赵");
  assert.equal(share.message_count, 2);
  assert.equal(typeof share.created_at, "string");
  const messages = share.messages as SessionHistoryMessage[];
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.equal(messages[1]?.card?.$type, "race-strategy");
  assert.equal(share.wxacode_url, null);
});

test("同选集二次创建 reused:true 且 sid 相同；乱序同选集也复用", async () => {
  const app = shareApp();
  const first = (await (await postShare(app, { indices: [0, 3] })).json()) as { sid: string };
  const second = await postShare(app, { indices: [0, 3] });
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as { sid: string; reused: boolean };
  assert.equal(secondBody.reused, true);
  assert.equal(secondBody.sid, first.sid);

  const shuffled = await postShare(app, { indices: [3, 0] });
  assert.equal(shuffled.status, 200);
  assert.equal(((await shuffled.json()) as { sid: string }).sid, first.sid);
});

test("31 条 → 422（中文提示）；伪造不存在的序号 → 400", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ type: "human", content: JSON.stringify({ timestamp: "t", message: `m${i}` }) }));
  const app = shareApp({ messages: many });
  const tooMany = await postShare(app, { indices: Array.from({ length: 31 }, (_, i) => i) });
  assert.equal(tooMany.status, 422);
  const tooManyBody = (await tooMany.json()) as { error: string };
  assert.match(tooManyBody.error, /最多分享/);

  const forged = await postShare(app, { indices: [0, 999] });
  assert.equal(forged.status, 400);
  assert.equal(((await forged.json()) as { error: string }).error, "invalid_indices");
});

test("单条超 64KB → 422（路由可达）；总体积超 2MB → 422（纯函数直测）", async () => {
  const huge = "x".repeat(65 * 1024);
  const app = shareApp({
    messages: [{ type: "human", content: JSON.stringify({ timestamp: "t", message: huge }) }, { type: "ai", content: "ok" }],
  });
  const single = await postShare(app, { indices: [0] });
  assert.equal(single.status, 422);
  assert.match(((await single.json()) as { error: string }).error, /单条上限/);

  // 每条 ≤64KB，但快照总体积能过 2MB（30 条 × 64KB 上限内理论最大 ~1.9MB，
  // 路由口径下该分支是纵深防御；纯函数直测用更多条触发，上限调整时兜底）。
  const chunk = "y".repeat(60 * 1024);
  const selected = Array.from({ length: 40 }, (_, i): SessionHistoryMessage => ({ role: "user", content: `${chunk}${i}` }));
  const payload = { messages: selected, strategy_refs: [] };
  assert.match(shareSizeError(selected.map((_, i) => i), selected, payload) ?? "", /总体积上限/);
  // 上限内的正常快照放行。
  assert.equal(shareSizeError([0], [{ role: "user", content: "你好" }], { messages: [{ role: "user", content: "你好" }], strategy_refs: [] }), undefined);
});

test("空 indices / 非法类型 / 非法 sharer_name → 400", async () => {
  const app = shareApp();
  for (const body of [{ indices: [] }, { indices: ["0"] }, { indices: [-1] }, { indices: [0.5] }, { sharer_name: 3, indices: [0] }, { no_indices: true }]) {
    const response = await postShare(app, body);
    assert.equal(response.status, 400, `body=${JSON.stringify(body)}`);
  }
  const longName = await postShare(app, { indices: [0], sharer_name: "名".repeat(65) });
  assert.equal(longName.status, 400);
});

test("无历史的 session → 404；校验失败的请求不落库", async () => {
  const store = new FakeShareStore();
  const app = shareApp({ store });
  const missing = await postShare(app, { indices: [0] }, "other-session");
  assert.equal(missing.status, 404);
  assert.equal(store.rows.size, 0);
});

test("wxacode 成功落 URL；fail-soft 不挡创建；复用补生成一次", async () => {
  const good = { calls: 0 };
  const store = new FakeShareStore();
  const app = shareApp({ store, wxacode: wxacodeClient(good) });
  const created = await postShare(app, { indices: [0] });
  const body = (await created.json()) as { sid: string; wxacode_url: string | null };
  assert.equal(good.calls, 1);
  assert.equal(body.wxacode_url, wxacodeUrl);
  assert.equal(store.rows.get(body.sid)?.wxacodeUrl, wxacodeUrl);

  // 复用：已有 URL 不再调用。
  const reused = await postShare(app, { indices: [0] });
  assert.equal(good.calls, 1);
  assert.equal(((await reused.json()) as { wxacode_url: string | null }).wxacode_url, wxacodeUrl);

  // 首建失败落 NULL，复用时补生成一次。
  const failing = { calls: 0 };
  const retryStore = new FakeShareStore();
  const retryApp = shareApp({ store: retryStore, wxacode: wxacodeClient(failing, null) });
  const failed = (await (await postShare(retryApp, { indices: [0] })).json()) as { sid: string; wxacode_url: string | null };
  assert.equal(failed.wxacode_url, null);
  assert.equal(failing.calls, 1);
  // 换一个成功的客户端模拟故障恢复后的再次分享。
  const recoveredApp = shareApp({ store: retryStore, wxacode: wxacodeClient(failing) });
  const recovered = await postShare(recoveredApp, { indices: [0] });
  assert.equal(failing.calls, 2);
  const recoveredBody = (await recovered.json()) as { reused: boolean; wxacode_url: string | null };
  assert.equal(recoveredBody.reused, true);
  assert.equal(recoveredBody.wxacode_url, wxacodeUrl);
});

test("公开读取：未知 sid 与非法 sid 均 404", async () => {
  const app = shareApp();
  assert.equal((await app.request("/api/coach-shares/AAAAAAAAAAAAAAAAAAAA11")).status, 404);
  assert.equal((await app.request("/api/coach-shares/too-short")).status, 404);
  assert.equal((await app.request("/api/coach-shares/带中文的sid带中文的sid带中")).status, 404);
});

test("过期行 → 410 expired；非 active → 410 gone", async () => {
  const store = new FakeShareStore();
  const app = shareApp({ store });
  const created = (await (await postShare(app, { indices: [0] })).json()) as { sid: string };
  store.age(created.sid, 31 * 24 * 60 * 60 * 1000);
  const expired = await app.request(`/api/coach-shares/${created.sid}`);
  assert.equal(expired.status, 410);
  assert.equal(((await expired.json()) as { error: string }).error, "expired");

  const fresh = (await (await postShare(app, { indices: [1] })).json()) as { sid: string };
  const row = store.rows.get(fresh.sid);
  if (row !== undefined) row.status = "revoked";
  const gone = await app.request(`/api/coach-shares/${fresh.sid}`);
  assert.equal(gone.status, 410);
  assert.equal(((await gone.json()) as { error: string }).error, "gone");
});

test("IP 频控：窗口内第 61 次 → 429", async () => {
  const app = shareApp();
  const sid = ((await (await postShare(app, { indices: [0] })).json()) as { sid: string }).sid;
  let last: Response | undefined;
  for (let i = 0; i < 60; i += 1) {
    last = await app.request(`/api/coach-shares/${sid}`, { headers: { "x-forwarded-for": "203.0.113.7" } });
  }
  assert.equal(last?.status, 200);
  const over = await app.request(`/api/coach-shares/${sid}`, { headers: { "x-forwarded-for": "203.0.113.7" } });
  assert.equal(over.status, 429);
  // 其他 IP 不受影响。
  const other = await app.request(`/api/coach-shares/${sid}`, { headers: { "x-forwarded-for": "198.51.100.9" } });
  assert.equal(other.status, 200);
});

test("OpenAPI 描述两条分享路径", async () => {
  const app = shareApp();
  const document = (await (await app.request("/openapi.json")).json()) as { paths: Record<string, Record<string, unknown>> };
  const create = document.paths["/api/users/me/coach/sessions/{session_id}/share"]?.post as Record<string, unknown>;
  assert.deepEqual(create.security, [{ bearerAuth: [] }]);
  const read = document.paths["/api/coach-shares/{sid}"]?.get as Record<string, unknown>;
  assert.equal(read.security, undefined);
});

test("extractStrategyRefs：race_event_id 入 ref，version_id 缺落 null，message_index 对齐快照", () => {
  const messages: SessionHistoryMessage[] = [
    { role: "user", content: "帮我制定策略" },
    { role: "assistant", content: "策略如下", card: { $type: "race-strategy", data: { race_event_id: 30 } } },
    { role: "assistant", content: "计划如下", card: { $type: "master-plan", data: { anything: 1 } } },
    { role: "assistant", content: "旧卡片", card: { $type: "race-strategy", data: {} } },
  ];
  assert.deepEqual(extractStrategyRefs("u-1", messages), [
    { user_id: "u-1", race_id: 30, version_id: null, message_index: 1 },
    { user_id: "u-1", race_id: null, version_id: null, message_index: 3 },
  ]);
});
