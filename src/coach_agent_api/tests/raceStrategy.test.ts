import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";

/** streamEvents stub for tests that must never stream. */
const neverStream = () => {
  throw new Error("must not stream");
};

const jwtVerifier = {
  async verify() {
    return { userId: "athlete-1", isAdmin: false };
  },
};

// 分段须与目标自洽（RaceStrategySchema superRefine：累计差 >60s 拒绝）：
// 42.195 km × 5:41/km ≈ 3:59:48，与 3:59:59 差 11s。
const strategy = {
  race_name: "杭州马拉松",
  item_type: "Marathon",
  target_finish_time: "3:59:59",
  summary: "前稳后渐进。",
  pace_segments: [
    { segment: "0–42.195 km", distance_km: 42.195, pace: "5:41/km", segment_time: "3:59:48", cumulative_time: "3:59:48", note: "全程匀速" },
  ],
  fueling_plan: [{ time_point: "赛前 30 分钟", content: "能量胶 1 支" }],
  course_tips: ["32km 爬坡提前降档"],
  weather_tips: ["穿背心+臂套"],
  basis_note: "近 90 天 L4 估计。",
};

function raceTarget(): Record<string, unknown> {
  return { kind: "race", race_event_id: 30, item_type: "Marathon" };
}

async function postChat(app: ReturnType<typeof createApp>, body: Record<string, unknown>): Promise<Response> {
  return app.request("/api/users/me/coach/chat", {
    method: "POST",
    headers: { authorization: "Bearer signed", "content-type": "application/json" },
    body: JSON.stringify({ session_id: "session-1", client_turn_id: "turn-1", message: "帮我制定比赛策略", ...body }),
  });
}

test("chat projects a race-strategy artifact as a typed card", async () => {
  const app = createApp({
    jwtVerifier,
    coachInvoker: {
      async invoke() {
        return { messages: [{ type: "ai", content: "初稿如下……" }], intent: { intent: "race_strategy" }, raceStrategy: strategy };
      },
      streamEvents: neverStream,
    },
  });

  const response = await postChat(app, { target: raceTarget() });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  // card 信封：$type = 客户端渲染器注册表 key；落库与否由用户在报告页「应用」
  // 决定，协议不再携带 race_strategy / race_strategy_saved。
  assert.deepEqual(body.card, { $type: "race-strategy", data: strategy });
  assert.equal(body.race_strategy, undefined);
  assert.equal(body.race_strategy_saved, undefined);
});

test("chat projects the card regardless of turn target (display artifact, not persistence)", async () => {
  const app = createApp({
    jwtVerifier,
    coachInvoker: {
      async invoke() {
        return { messages: [{ type: "ai", content: "初稿如下……" }], intent: { intent: "race_strategy" }, raceStrategy: strategy };
      },
      streamEvents: neverStream,
    },
  });

  const response = await postChat(app, {});
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body.card, { $type: "race-strategy", data: strategy });
});

test("chat does not project a stale strategy on a later plain turn", async () => {
  // raceStrategy 是跨轮 state channel：上一轮的产物会残留在 checkpoint 里。
  // 后续 routed to qa 的普通轮即使带着旧值，也不得再下发卡片。门槛：本轮
  // intent 必须就是 race_strategy。
  const app = createApp({
    jwtVerifier,
    coachInvoker: {
      async invoke() {
        return { messages: [{ type: "ai", content: "不客气！" }], intent: { intent: "training_question" }, raceStrategy: strategy };
      },
      streamEvents: neverStream,
    },
  });

  const response = await postChat(app, { target: raceTarget() });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.card, undefined);
});

test("chat rejects a race target without race_event_id", async () => {
  const app = createApp({
    jwtVerifier,
    coachInvoker: {
      async invoke() {
        throw new Error("must not invoke");
      },
      streamEvents: neverStream,
    },
  });

  const response = await postChat(app, { target: { kind: "race", item_type: "Marathon" } });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_turn_scope" });
});
