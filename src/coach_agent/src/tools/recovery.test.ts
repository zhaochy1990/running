import assert from "node:assert/strict";
import test from "node:test";
import type { DailyRecovery, DataProvider, VendorHrvBaseline } from "../data/dataProvider.js";
import { createRecoveryTools } from "./recovery.js";

const userId = "athlete-1";
const asof = "2026-10-09";

interface ProviderOver {
  recovery?: DailyRecovery[];
  baseline?: VendorHrvBaseline | null;
  onQuery?: (startDay: string, endDay: string) => void;
}

function makeProvider(over: ProviderOver = {}): DataProvider {
  return {
    async getDailyRecoveryByDateRange(_uid: string, startDay: string, endDay: string) {
      over.onQuery?.(startDay, endDay);
      return (over.recovery ?? []).filter((row) => row.date >= startDay && row.date <= endDay);
    },
    async getVendorHrvBaseline() {
      return over.baseline ?? null;
    },
  } as unknown as DataProvider;
}

function invoke(provider: DataProvider, input: { days?: number } = {}) {
  const [tool] = createRecoveryTools(provider);
  assert.ok(tool);
  assert.equal(tool.name, "get_recovery_status");
  return tool.invoke(input, { context: { userId, asof } });
}

/** 从 startDay 起连续 count 天的恢复行；rhr/hrv 用函数按天给值。 */
function series(startDay: string, count: number, values: (index: number) => { rhr?: number | null; hrv?: number | null }): DailyRecovery[] {
  const start = new Date(`${startDay}T00:00:00Z`).getTime();
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    rhr: values(index).rhr ?? null,
    hrv: values(index).hrv ?? null,
  }));
}

const BASELINE: VendorHrvBaseline = { low: 45, high: 62, provider: "garmin", date: "2026-10-09" };

/** 09-13..10-09（27 天）：近 7 日(10-03..10-09) rhr=52、前 7 日(09-26..10-02) rhr=48（→ +4 rising）；hrv 除 10-01/10-05 外 50，昨晚 38。 */
function fullSeries(): DailyRecovery[] {
  return series("2026-09-13", 27, (index) => {
    const dayOfMonth = 13 + index;
    return {
      rhr: dayOfMonth >= 33 ? 52 : dayOfMonth >= 26 ? 48 : 47,
      hrv: dayOfMonth === 31 || dayOfMonth === 35 ? null : dayOfMonth === 39 ? 38 : 50,
    };
  });
}

test("recovery: series aggregation, baseline classification, rhr trend, coverage", async () => {
  const queries: Array<[string, string]> = [];
  const result = await invoke(makeProvider({ recovery: fullSeries(), baseline: BASELINE, onQuery: (s, e) => queries.push([s, e]) }));

  assert.equal(result.available, true);
  if (!result.available) return;
  // 默认窗口 14 天；趋势锚定需要 14+13=27 天取数（09-13..10-09）。
  assert.deepEqual(queries, [["2026-09-13", "2026-10-09"]]);
  assert.equal(result.asOf, "2026-10-09");
  assert.equal(result.days, 14);
  assert.equal(result.daily.length, 14);
  assert.equal(result.daily[0]?.date, "2026-09-26");
  assert.equal(result.daily.at(-1)?.date, "2026-10-09");
  assert.deepEqual(result.hrvBaseline, BASELINE);
  // 昨晚 38 < 基线下沿 45 → below；双 provider 的 MAX 合并在 SQL 层完成，这里按合并后的行透传。
  assert.deepEqual(result.lastNight, { date: "2026-10-09", hrv: 38, vsBaseline: "below" });
  assert.deepEqual(result.rhrTrend, { available: true, recent7Avg: 52, recent7Days: 7, prior7Avg: 48, prior7Days: 7, deltaBpm: 4, direction: "rising" });
  assert.deepEqual(result.coverage, { windowDays: 14, daysWithHrv: 12, daysWithRhr: 14, provider: "garmin" });
  assert.deepEqual(result.provenance, { source: "stride", vendor_derived: false });
});

test("recovery: lastNight classification within / above / no baseline", async () => {
  const hrv = (value: number) => series("2026-10-02", 8, () => ({ rhr: 50, hrv: value }));
  const within = await invoke(makeProvider({ recovery: hrv(52), baseline: BASELINE }));
  assert.equal(within.available, true);
  if (within.available) assert.deepEqual(within.lastNight, { date: "2026-10-09", hrv: 52, vsBaseline: "within" });

  const above = await invoke(makeProvider({ recovery: hrv(65), baseline: BASELINE }));
  assert.equal(above.available, true);
  if (above.available) assert.deepEqual(above.lastNight, { date: "2026-10-09", hrv: 65, vsBaseline: "above" });

  const noBaseline = await invoke(makeProvider({ recovery: hrv(52), baseline: null }));
  assert.equal(noBaseline.available, true);
  if (noBaseline.available) {
    assert.deepEqual(noBaseline.lastNight, { date: "2026-10-09", hrv: 52, vsBaseline: "no_data" });
    assert.equal(noBaseline.hrvBaseline, null);
    assert.equal(noBaseline.coverage.provider, null);
  }

  const noHrv = await invoke(makeProvider({ recovery: series("2026-10-02", 8, () => ({ rhr: 50, hrv: null })), baseline: BASELINE }));
  assert.equal(noHrv.available, true);
  if (noHrv.available) assert.deepEqual(noHrv.lastNight, { date: null, hrv: null, vsBaseline: "no_data" });
});

test("recovery: rhr trend falling / stable thresholds", async () => {
  const trend = (prior: number) => invoke(makeProvider({ recovery: series("2026-09-13", 27, (index) => ({ rhr: 13 + index >= 33 ? 52 : prior, hrv: 50 })) }));

  const falling = await trend(56);
  assert.equal(falling.available, true);
  if (falling.available)
    assert.deepEqual(falling.rhrTrend, { available: true, recent7Avg: 52, recent7Days: 7, prior7Avg: 56, prior7Days: 7, deltaBpm: -4, direction: "falling" });

  const stable = await trend(51);
  assert.equal(stable.available, true);
  if (stable.available)
    assert.deepEqual(stable.rhrTrend, { available: true, recent7Avg: 52, recent7Days: 7, prior7Avg: 51, prior7Days: 7, deltaBpm: 1, direction: "stable" });
});

test("recovery: days=7 truncates series but trend still uses the 14-day window", async () => {
  const result = await invoke(makeProvider({ recovery: fullSeries(), baseline: BASELINE }), { days: 7 });

  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.days, 7);
  assert.equal(result.daily.length, 7);
  assert.equal(result.daily[0]?.date, "2026-10-03");
  assert.deepEqual(result.coverage, { windowDays: 7, daysWithHrv: 6, daysWithRhr: 7, provider: "garmin" });
  assert.deepEqual(result.rhrTrend, { available: true, recent7Avg: 52, recent7Days: 7, prior7Avg: 48, prior7Days: 7, deltaBpm: 4, direction: "rising" });
});

test("recovery: trend anchored on the last day with rhr, not asof", async () => {
  // rhr 停在 10-05（厂商停更 4 天）：recent=09-29..10-05、prior=09-22..09-28。
  const recovery = series("2026-09-22", 14, (index) => (index >= 7 ? { rhr: 54, hrv: 40 } : { rhr: 50, hrv: null }));
  const result = await invoke(makeProvider({ recovery, baseline: BASELINE }));

  assert.equal(result.available, true);
  if (!result.available) return;
  assert.deepEqual(result.rhrTrend, { available: true, recent7Avg: 54, recent7Days: 7, prior7Avg: 50, prior7Days: 7, deltaBpm: 4, direction: "rising" });
  // lastNight 取整个取数序列里最新有 hrv 的一天，日期如实带给 LLM。
  assert.deepEqual(result.lastNight, { date: "2026-10-05", hrv: 40, vsBaseline: "below" });
  // 序列按请求的日历窗口截断（≥ 09-26）：10 行，不是整个取数序列。
  assert.equal(result.daily.length, 10);
  assert.equal(result.daily[0]?.date, "2026-09-26");

  // days=3 时窗口内（≥ 10-07）已无数据：daily 空、coverage 归零，但 lastNight/趋势仍如实报告。
  const narrow = await invoke(makeProvider({ recovery, baseline: BASELINE }), { days: 3 });
  assert.equal(narrow.available, true);
  if (!narrow.available) return;
  assert.deepEqual(narrow.daily, []);
  assert.deepEqual(narrow.coverage, { windowDays: 3, daysWithHrv: 0, daysWithRhr: 0, provider: "garmin" });
  assert.deepEqual(narrow.lastNight, { date: "2026-10-05", hrv: 40, vsBaseline: "below" });
});

test("recovery: insufficient rhr degrades the trend but keeps the rest", async () => {
  const result = await invoke(makeProvider({ recovery: series("2026-10-02", 8, () => ({ rhr: null, hrv: 48 })), baseline: BASELINE }));

  assert.equal(result.available, true);
  if (!result.available) return;
  assert.deepEqual(result.rhrTrend, { available: false, reason: "insufficient_rhr_data" });
  assert.deepEqual(result.coverage, { windowDays: 14, daysWithHrv: 8, daysWithRhr: 0, provider: "garmin" });
  assert.deepEqual(result.lastNight, { date: "2026-10-09", hrv: 48, vsBaseline: "within" });
});

test("recovery: no recovery data at all degrades with reason", async () => {
  const empty = await invoke(makeProvider({ recovery: [], baseline: BASELINE }));
  assert.deepEqual(empty, { available: false, reason: "no_recovery_data", provenance: { source: "stride", vendor_derived: false } });

  const allNull = await invoke(makeProvider({ recovery: series("2026-10-02", 8, () => ({})), baseline: BASELINE }));
  assert.deepEqual(allNull, { available: false, reason: "no_recovery_data", provenance: { source: "stride", vendor_derived: false } });
});
