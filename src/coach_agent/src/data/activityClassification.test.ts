import assert from "node:assert/strict";
import test from "node:test";
import { isQualityRunningActivity, isRunningActivity, normalizeSessionClass } from "./activityClassification.js";

function activity(overrides: Partial<{ name: string | null; sport: string | null; sportName: string | null; sportNote: string | null; strideSessionClass: string | null }>) {
  return {
    name: null,
    sport: "run_outdoor",
    sportName: "Outdoor Run",
    sportNote: null,
    strideSessionClass: null,
    ...overrides,
  };
}

test("running classification accepts canonical sport fields", () => {
  assert.equal(isRunningActivity(activity({ sport: "run_outdoor", sportName: null })), true);
  assert.equal(isRunningActivity(activity({ sport: null, sportName: "Outdoor Run" })), true);
});

test("post-#745 session classes decide quality directly", () => {
  assert.equal(isQualityRunningActivity(activity({ name: "Short repetitions", strideSessionClass: "quality" })), true);
  assert.equal(isQualityRunningActivity(activity({ name: "Long run", strideSessionClass: "long_quality" })), true);
  assert.equal(isQualityRunningActivity(activity({ name: "City marathon", strideSessionClass: "race" })), true);
  assert.equal(isQualityRunningActivity(activity({ name: "Easy run", strideSessionClass: "long_easy" })), false);
  assert.equal(isQualityRunningActivity(activity({ name: "Easy run", strideSessionClass: "easy" })), false);
  assert.equal(isQualityRunningActivity(activity({ name: "Easy run", strideSessionClass: "unknown" })), false);
  // strides 是补充课，不算质量课（丹尼尔斯教义）。
  assert.equal(isQualityRunningActivity(activity({ name: "8 x 100m", strideSessionClass: "strides" })), false);
});

test("legacy session classes stay recognised forever (rows outside the compute window are never rewritten)", () => {
  assert.equal(isQualityRunningActivity(activity({ name: "Easy run", strideSessionClass: "tempo" })), true);
  assert.equal(isQualityRunningActivity(activity({ name: "Easy run", strideSessionClass: "interval" })), true);
  assert.equal(isQualityRunningActivity(activity({ name: "Easy run", strideSessionClass: "race" })), true);
  assert.equal(isQualityRunningActivity(activity({ name: "Easy run", strideSessionClass: "long" })), false);
  assert.equal(isQualityRunningActivity(activity({ name: "Easy run", strideSessionClass: "easy" })), false);
});

test("quality classification falls back to descriptive name when the class is absent or unrecognised", () => {
  assert.equal(
    isQualityRunningActivity(activity({ name: "Hill repeats", strideSessionClass: "aerobic" })),
    true,
  );
  assert.equal(
    isQualityRunningActivity(activity({ name: "上海马拉松", strideSessionClass: "base" })),
    true,
  );
  assert.equal(
    isQualityRunningActivity(activity({ name: "3 x 10 min tempo", strideSessionClass: "base" })),
    true,
  );
  assert.equal(
    isQualityRunningActivity(activity({ name: "Long run", sportNote: "后段 8 km 马配", strideSessionClass: "aerobic" })),
    true,
  );
  assert.equal(
    isQualityRunningActivity(activity({ name: "Easy hilly run", strideSessionClass: "base" })),
    false,
  );
  // 未识别的新旧之外的值不当作质量信号——分类靠课名兜底。
  assert.equal(
    isQualityRunningActivity(activity({ name: "Easy run", strideSessionClass: "sprint" })),
    false,
  );
});

test("non-running sports are never quality running activities", () => {
  assert.equal(
    isQualityRunningActivity(activity({ name: "Tempo ride", sport: "bike", sportName: "Cycling", strideSessionClass: "tempo" })),
    false,
  );
});

test("normalizeSessionClass folds legacy values onto the new taxonomy", () => {
  assert.equal(normalizeSessionClass("tempo"), "quality");
  assert.equal(normalizeSessionClass("interval"), "quality");
  assert.equal(normalizeSessionClass("long"), "long_easy");
  // 新值与非枚举字符串原样透传：这是分组键，不是校验器。
  assert.equal(normalizeSessionClass("quality"), "quality");
  assert.equal(normalizeSessionClass("long_quality"), "long_quality");
  assert.equal(normalizeSessionClass("easy"), "easy");
  assert.equal(normalizeSessionClass(null), null);
  assert.equal(normalizeSessionClass("garbage"), "garbage");
});
