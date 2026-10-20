import assert from "node:assert/strict";
import test from "node:test";
import { RaceStrategyDirectResponseSchema, RaceStrategySchema } from "./schema.js";

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

test("race strategy defaults the packing checklist for content without it", () => {
  // 旧版本内容无 fueling_checklist：存储态解析不拦，读侧按空清单隐藏
  const parsed = RaceStrategySchema.safeParse(validStrategy);
  assert.equal(parsed.success, true);
  if (parsed.success) assert.deepEqual(parsed.data.fueling_checklist, []);
});

test("race strategy accepts a packing checklist with counts", () => {
  const parsed = RaceStrategySchema.safeParse({
    ...validStrategy,
    fueling_checklist: [
      { item: "能量胶（普通）", count: 3, note: "前半程每 40 分钟一支" },
      { item: "双倍胶", count: 2, note: "30 km 起用，含咖啡因" },
      { item: "盐丸（颗粒）", count: 4, note: "需水送服" },
    ],
  });
  assert.equal(parsed.success, true);
});

test("direct envelope rejects a strategy without the packing checklist", () => {
  // 生成态（ToolStrategy 结构化输出）比存储态严：清单必须给出，缺了打回重试
  const envelope = {
    disposition: "return_direct",
    content: { ...validStrategy, fueling_plan: [{ time_point: "赛前 30 分钟", content: "能量胶 1 支" }] },
  };
  const missing = RaceStrategyDirectResponseSchema.safeParse(envelope);
  assert.equal(missing.success, false);
  const withChecklist = RaceStrategyDirectResponseSchema.safeParse({
    ...envelope,
    content: { ...envelope.content, fueling_checklist: [{ item: "能量胶（普通）", count: 3, note: "" }] },
  });
  assert.equal(withChecklist.success, true);
});
