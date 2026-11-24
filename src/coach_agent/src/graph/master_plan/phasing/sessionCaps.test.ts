import assert from "node:assert/strict";
import { test } from "node:test";
import { LONG_RUN_MAX_MIN, longRunMaxKm, longRunMaxKmOfZone } from "./sessionCaps.js";

test("长跑公里上限：E 配速下 180 分钟能跑完的距离，向下取整到 0.1km，至多 40km", () => {
  // 期望值手算，不复用实现：10800÷391 = 27.62 → 27.6；÷312 = 34.615 → 34.6（按 312 折算 179.5 分钟，不超 180）
  assert.equal(longRunMaxKm(391), 27.6);
  assert.equal(longRunMaxKm(312), 34.6);
  assert.ok((34.6 * 312) / 60 <= LONG_RUN_MAX_MIN);
  // 250s/km（≈4'10"/km）：180 分钟 = 43.2km → 封在 40
  assert.equal(longRunMaxKm(250), 40);
  // 由 E 带算：取带中点
  assert.equal(longRunMaxKmOfZone([380, 402]), 27.6);
});
