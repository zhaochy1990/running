import assert from "node:assert/strict";
import test from "node:test";
import { RaceStrategySchema } from "./schema.js";

const validStrategy = {
  race_name: "杭州马拉松",
  item_type: "Marathon",
  target_finish_time: "3:59:59",
  summary: "前稳后渐进。",
  // 42.195 km × 5:41/km ≈ 3:59:48，与目标差 11s（< 60s 容差）
  pace_segments: [{ segment: "0–42.195 km", distance_km: 42.195, pace: "5:41/km", segment_time: "3:59:48", cumulative_time: "3:59:48", note: "全程匀速" }],
  fueling_plan: [{ time_point: "赛前 30 分钟", content: "能量胶 1 支" }],
  course_tips: [],
  weather_tips: [],
  basis_note: "",
};

test("race strategy accepts a self-consistent pace table", () => {
  const parsed = RaceStrategySchema.safeParse(validStrategy);
  assert.equal(parsed.success, true);
});

test("race strategy rejects a pace table that misses the target finish time", () => {
  const parsed = RaceStrategySchema.safeParse({
    ...validStrategy,
    // 10km × 5:45/km = 57:30，与 3:59:59 差远超 60s
    pace_segments: [{ segment: "0–10 km", distance_km: 10, pace: "5:45/km", segment_time: "57:30", cumulative_time: "57:30", note: "" }],
  });
  assert.equal(parsed.success, false);
  const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join("; ");
  assert.match(message, /deviates from target/);
});

test("race strategy skips the arithmetic check when rows are not computable", () => {
  // 距离全缺失：文本口径交给报告页 recompute，schema 不硬卡
  const parsed = RaceStrategySchema.safeParse({
    ...validStrategy,
    pace_segments: [{ segment: "前半程", distance_km: null, pace: "约 5:45", segment_time: "1:59:30", cumulative_time: "1:59:30", note: "" }],
  });
  assert.equal(parsed.success, true);
});

test("race strategy rejects a malformed target finish time", () => {
  const parsed = RaceStrategySchema.safeParse({ ...validStrategy, target_finish_time: "3.99.59" });
  assert.equal(parsed.success, false);
});
