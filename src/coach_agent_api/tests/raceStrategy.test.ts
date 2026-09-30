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

const strategy = {
  race_name: "杭州马拉松",
  item_type: "Marathon",
  target_finish_time: "3:59:59",
  summary: "前稳后渐进。",
  pace_segments: [
    { segment: "0–10 km", distance_km: 10, pace: "5:45/km", segment_time: "57:30", cumulative_time: "57:30", note: "压住兴奋" },
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
        return { messages: [{ type: "ai", content: "初稿如下……" }], raceStrategy: strategy };
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
        return { messages: [{ type: "ai", content: "普通回复" }], raceStrategy: strategy };
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
        return { messages: [{ type: "ai", content: "初稿如下……" }], raceStrategy: strategy };
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
