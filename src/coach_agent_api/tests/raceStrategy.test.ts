import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import type { RaceStrategyWriter } from "../src/routes/chat.js";

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

test("chat persists a race strategy produced under a race target", async () => {
  const saves: Array<{ userId: string; raceEventId: number; itemType: string }> = [];
  const writer: RaceStrategyWriter = {
    async saveRaceStrategy(userId, raceEventId, itemType) {
      saves.push({ userId, raceEventId, itemType });
      return true;
    },
  };
  const app = createApp({
    jwtVerifier,
    coachInvoker: {
      async invoke() {
        return { messages: [{ type: "ai", content: "初稿如下……" }], intent: { intent: "race_strategy" }, raceStrategy: strategy };
      },
      streamEvents: neverStream,
    },
    raceStrategyWriter: writer,
  });

  const response = await postChat(app, { target: raceTarget() });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.race_strategy_saved, true);
  assert.deepEqual(body.race_strategy, strategy);
  assert.deepEqual(saves, [{ userId: "athlete-1", raceEventId: 30, itemType: "Marathon" }]);
});

test("chat skips persistence without a race target", async () => {
  let saves = 0;
  const app = createApp({
    jwtVerifier,
    coachInvoker: {
      async invoke() {
        return { messages: [{ type: "ai", content: "普通回复" }], intent: { intent: "race_strategy" }, raceStrategy: strategy };
      },
      streamEvents: neverStream,
    },
    raceStrategyWriter: {
      async saveRaceStrategy() {
        saves += 1;
        return true;
      },
    },
  });

  const response = await postChat(app, {});
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.race_strategy_saved, undefined);
  assert.equal(saves, 0);
});

test("chat survives a failed race-strategy write", async () => {
  const app = createApp({
    jwtVerifier,
    coachInvoker: {
      async invoke() {
        return { messages: [{ type: "ai", content: "初稿如下……" }], intent: { intent: "race_strategy" }, raceStrategy: strategy };
      },
      streamEvents: neverStream,
    },
    raceStrategyWriter: {
      async saveRaceStrategy() {
        return false;
      },
    },
  });

  const response = await postChat(app, { target: raceTarget() });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.race_strategy_saved, undefined);
  assert.deepEqual(body.race_strategy, strategy);
});

test("chat skips persistence when the artifact fails canonical validation", async () => {
  let saves = 0;
  const app = createApp({
    jwtVerifier,
    coachInvoker: {
      async invoke() {
        return { messages: [{ type: "ai", content: "初稿如下……" }], raceStrategy: { race_name: "不完整" } };
      },
      streamEvents: neverStream,
    },
    raceStrategyWriter: {
      async saveRaceStrategy() {
        saves += 1;
        return true;
      },
    },
  });

  const response = await postChat(app, { target: raceTarget() });
  assert.equal(response.status, 200);
  assert.equal(saves, 0);
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

test("chat does not re-persist a stale strategy on a later plain turn", async () => {
  // raceStrategy 是跨轮 state channel：上一轮的产物会残留在 checkpoint 里。
  // 后续 routed to qa 的普通轮即使带着旧值，也不得再次落库（否则覆盖用户
  // 在报告页的手动编辑）。门槛：本轮 intent 必须就是 race_strategy。
  let saves = 0;
  const app = createApp({
    jwtVerifier,
    coachInvoker: {
      async invoke() {
        return { messages: [{ type: "ai", content: "不客气！" }], intent: { intent: "training_question" }, raceStrategy: strategy };
      },
      streamEvents: neverStream,
    },
    raceStrategyWriter: {
      async saveRaceStrategy() {
        saves += 1;
        return true;
      },
    },
  });

  const response = await postChat(app, { target: raceTarget() });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.race_strategy, undefined);
  assert.equal(body.race_strategy_saved, undefined);
  assert.equal(saves, 0);
});
