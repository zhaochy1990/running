/** POC exploration: compare sessions and training blocks, not a new baseline estimator. */
import { addDays } from "@stride/contract";
import { type Conclusion, type Evidence, finite, refs, runningEvidence, type Snapshot } from "./types.js";

const day = (e: Evidence) => String(e.kind === "activity" ? (e.content.shanghaiDay ?? "") : (e.content.date ?? ""));
const round = (n: number, digits = 1) => Number(n.toFixed(digits));
const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

interface Segment {
  distanceM: number;
  durationS: number;
  hr: number | null;
}
function segments(e: Evidence): Segment[] {
  if (!Array.isArray(e.content.laps)) return [];
  return e.content.laps
    .toSorted((a, b) => Number(a.lapIndex) - Number(b.lapIndex))
    .flatMap((lap) => {
      const distanceM = finite(lap.distanceM),
        durationS = finite(lap.durationS);
      return distanceM !== null && distanceM > 0 && durationS !== null && durationS > 0 ? [{ distanceM, durationS, hr: finite(lap.avgHr) }] : [];
    });
}

/** Fixed distance blocks, proportional overlap at lap boundaries; not the existing half-split algorithm. */
export function distanceBlock(e: Evidence, startM: number, endM: number, rounded = true) {
  if (startM < 0 || endM <= startM) return null;
  const laps = segments(e);
  let position = 0,
    distanceM = 0,
    durationS = 0,
    hrTime = 0,
    hrDuration = 0;
  for (const lap of laps) {
    const overlap = Math.max(0, Math.min(position + lap.distanceM, endM) - Math.max(position, startM));
    position += lap.distanceM;
    if (!overlap) continue;
    const duration = (lap.durationS * overlap) / lap.distanceM;
    distanceM += overlap;
    durationS += duration;
    if (lap.hr !== null && lap.hr > 0) {
      hrTime += lap.hr * duration;
      hrDuration += duration;
    }
  }
  if (distanceM < (endM - startM) * 0.99) return null;
  const paceSKm = (durationS / distanceM) * 1000,
    hr = hrDuration ? hrTime / hrDuration : null;
  return { startKm: startM / 1000, endKm: endM / 1000, paceSKm: rounded ? round(paceSKm) : paceSKm, hr: hr === null ? null : rounded ? round(hr) : hr };
}

export function supportsDistanceBlocks(e: Evidence) {
  const laps = segments(e),
    distance = finite(e.content.distanceM),
    duration = finite(e.content.durationS);
  if (!distance || !duration || laps.length < 3 || laps.some((l) => l.distanceM > 5000.5)) return false;
  return (
    Math.abs(laps.reduce((s, l) => s + l.distanceM, 0) - distance) / distance <= 0.02 &&
    Math.abs(laps.reduce((s, l) => s + l.durationS, 0) - duration) / duration <= 0.1
  );
}

export function activityCityLabel(e: Evidence) {
  return /([^\s]+市)/u.exec(String(e.content.name))?.[1] ?? null;
}

export function buildComparisons(snapshot: Snapshot) {
  const runs = runningEvidence(snapshot);
  const observations: Array<Conclusion & { measurements: unknown }> = [];
  const add = (id: string, title: string, text: string, dimension: string, rows: Evidence[], measurements: unknown, conditions: string) => {
    if (!rows.length) return;
    observations.push({
      id,
      kind: "fact",
      title,
      text,
      dimension,
      lifecycle: "rolling",
      evidence: refs([...new Map(rows.map((row) => [row.id, row])).values()]),
      sourceDates: [...new Set(rows.map(day).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort(),
      conditions,
      limitations: [],
      measurements,
    });
  };
  const weeks = [];
  for (let end = snapshot.endDay; addDays(end, -6) >= snapshot.startDay; end = addDays(end, -7)) {
    const start = addDays(end, -6),
      rows = runs.filter((e) => day(e) >= start && day(e) <= end);
    const known = rows.every((e) => finite(e.content.distanceM) !== null && Number(e.content.distanceM) >= 0);
    const volume = known ? rows.reduce((s, e) => s + Number(e.content.distanceM), 0) / 1000 : null;
    const longest = rows.toSorted((a, b) => Number(b.content.distanceM) - Number(a.content.distanceM))[0];
    const days = [...new Set(rows.map(day))];
    const keyDays = [...new Set(rows.filter((e) => ["quality", "long_quality", "race"].includes(String(e.content.strideSessionClass))).map(day))];
    weeks.push({
      start,
      end,
      km: volume === null ? null : round(volume),
      runDays: days.length,
      keyDays: keyDays.length,
      longestKm: longest ? round(Number(longest.content.distanceM) / 1000) : null,
      longestShare: volume && longest ? round((Number(longest.content.distanceM) / 1000 / volume) * 100) : null,
    });
  }
  const recent = weeks.slice(0, 4),
    highest = weeks
      .filter((w) => w.km !== null)
      .toSorted((a, b) => Number(b.km) - Number(a.km))
      .slice(0, 4);
  if (recent.length === 4 && recent.every((w) => w.km !== null))
    add(
      "comparison-week-structure",
      "近期承载结构与高量期的区别",
      `最近4个完整7天区间平均记录跑量 ${round(average(recent.flatMap((w) => (w.km === null ? [] : [w.km]))))} 公里，跑步日分别为 ${recent.map((w) => w.runDays).join("、")}；最高量4个区间的平均跑量 ${round(average(highest.map((w) => Number(w.km))))} 公里、跑步日 ${highest.map((w) => w.runDays).join("、")}。`,
      "训练承载结构",
      runs,
      { recent, highest },
      "7天区间按窗口结束日对齐；keyDays是已有系统分类，不等于同一种生理强度。四个最高量区间未必连续。",
    );

  const loadRows = snapshot.evidence.filter((e) => e.active && e.kind === "load");
  const loadByDay = new Map(loadRows.map((e) => [String(e.content.date), e]));
  const loadWeeks = [];
  const loadSources: Evidence[] = [];
  for (const week of recent) {
    const rows = loadRows.filter((e) => String(e.content.date) >= week.start && String(e.content.date) <= week.end);
    if (
      rows.length !== 7 ||
      new Set(rows.map((e) => e.content.date)).size !== 7 ||
      rows.some(
        (e) =>
          finite(e.content.trainingDose) === null ||
          Number(e.content.trainingDose) < 0 ||
          !["complete", "rest_confirmed"].includes(String(e.content.coverageStatus)),
      )
    )
      continue;
    const totalDose = rows.reduce((s, e) => s + Number(e.content.trainingDose), 0);
    if (totalDose <= 0) continue;
    const ranked = rows.toSorted((a, b) => Number(b.content.trainingDose) - Number(a.content.trainingDose));
    const peak = ranked[0];
    if (!peak) continue;
    const peakDay = String(peak.content.date),
      prior = loadByDay.get(addDays(peakDay, -1));
    const peakActivities = runs.filter((e) => day(e) === peakDay);
    loadSources.push(...rows, ...peakActivities, ...(prior ? [prior] : []));
    loadWeeks.push({
      start: week.start,
      end: week.end,
      totalDose: round(totalDose),
      peakDay,
      peakDayDose: round(Number(peak.content.trainingDose)),
      peakDaySharePct: round((Number(peak.content.trainingDose) / totalDose) * 100),
      topTwoDaySharePct: round((ranked.slice(0, 2).reduce((s, e) => s + Number(e.content.trainingDose), 0) / totalDose) * 100),
      acuteBefore: prior?.content.acuteLoad ?? null,
      acuteAfter: peak.content.acuteLoad,
      loadRatioAfter: peak.content.loadRatio,
      peakActivities: peakActivities.map((e) => ({ sourceId: e.id, name: e.content.name, distanceKm: round(Number(e.content.distanceM) / 1000) })),
    });
  }
  if (loadWeeks.length)
    add(
      "comparison-load-concentration",
      "周内实际剂量的集中程度",
      `最近覆盖完整的 ${loadWeeks.length} 个7天区间，最高剂量日占全周 ${loadWeeks.map((w) => w.peakDaySharePct).join("、")}% ，最高两日合计占 ${loadWeeks.map((w) => w.topTwoDaySharePct).join("、")}%。`,
      "周内刺激与恢复布局",
      loadSources,
      loadWeeks,
      "直接引用STRIDE已有daily load，不重算EWMA；仅完整覆盖周参与。集中度描述实际刺激分布，不据此诊断风险或自动放行加量。",
    );

  const longRows = runs.filter((e) => day(e) >= addDays(snapshot.endDay, -55) && Number(e.content.distanceM) >= 25000);
  const longRuns = [];
  const longSources: Evidence[] = [];
  for (const e of longRows) {
    const distance = finite(e.content.distanceM);
    if (!distance || !supportsDistanceBlocks(e)) continue;
    const fullDistance = Math.floor(distance / 1000) * 1000;
    const first = distanceBlock(e, 0, 10000),
      last = distanceBlock(e, fullDistance - 10000, fullDistance);
    if (!first || !last) continue;
    longSources.push(e);
    longRuns.push({
      sourceId: e.id,
      day: day(e),
      name: e.content.name,
      distanceKm: round(distance / 1000),
      feelsLike: e.content.feelsLike,
      first10km: first,
      last10km: last,
      paceChangePct: round((last.paceSKm / first.paceSKm - 1) * 100),
      blocks: Array.from({ length: Math.floor(fullDistance / 10000) }, (_, i) => distanceBlock(e, i * 10000, (i + 1) * 10000)),
      sessionClass: e.content.strideSessionClass,
    });
  }
  if (longRuns.length)
    add(
      "comparison-long-run-execution",
      "长跑后段的实际保持能力",
      `近56天有 ${longRuns.length} 次至少25公里且分段覆盖合格的长跑，末10公里较首10公里配速变化分别为 ${longRuns.map((r) => `${r.day} ${r.paceChangePct}%`).join("；")}（负值为加速）。`,
      "长距离后程表现",
      longSources,
      longRuns,
      "10公里区块按累计距离计算；跨分段边界按比例分配。保留主动递进、间歇等训练类型，描述执行能力，不用心率上升直接判疲劳。",
    );

  // Exploratory matched comparisons: all qualifying pairs retained in diagnostics;
  // nearest pace first, then nearest date; no outcome-based selection, no activity reused.
  const easy = runs.filter(
    (e) =>
      e.content.sport === "run_outdoor" &&
      e.content.strideSessionClass === "easy" &&
      Number(e.content.distanceM) >= 5000 &&
      Number(e.content.distanceM) <= 18000 &&
      finite(e.content.feelsLike) !== null &&
      finite(e.content.avgHr) !== null &&
      finite(e.content.avgPaceSKm) !== null &&
      finite(e.content.ascentM) !== null &&
      Number(e.content.ascentM) / Number(e.content.distanceM) < 0.005,
  );
  const city = activityCityLabel;
  const eligible = [];
  for (let i = 0; i < easy.length; i++)
    for (const b of easy.slice(i + 1)) {
      const a = easy[i];
      if (!a) continue;
      if (!city(a) || city(a) !== city(b)) continue;
      const gap = Math.abs(Date.parse(day(a)) - Date.parse(day(b))) / 86400000;
      const paceGap = Math.abs(Number(a.content.avgPaceSKm) - Number(b.content.avgPaceSKm));
      if (
        gap < 1 ||
        gap > 21 ||
        paceGap > 5 ||
        Math.max(Number(a.content.distanceM), Number(b.content.distanceM)) / Math.min(Number(a.content.distanceM), Number(b.content.distanceM)) > 1.3 ||
        Math.abs(Number(a.content.feelsLike) - Number(b.content.feelsLike)) < 5 ||
        a.content.provider !== b.content.provider
      )
        continue;
      const hot = Number(a.content.feelsLike) > Number(b.content.feelsLike) ? a : b,
        cool = hot === a ? b : a;
      eligible.push({ hot, cool, gap, paceGap, hrDelta: Number(hot.content.avgHr) - Number(cool.content.avgHr) });
    }
  const used = new Set<string>();
  const pairs = eligible
    .toSorted((a, b) => a.paceGap - b.paceGap || a.gap - b.gap || a.hot.id.localeCompare(b.hot.id))
    .filter((p) => {
      if (used.has(p.hot.id) || used.has(p.cool.id)) return false;
      used.add(p.hot.id);
      used.add(p.cool.id);
      return true;
    });
  const pairView = (p: (typeof pairs)[number]) => ({
    hot: {
      sourceId: p.hot.id,
      day: day(p.hot),
      pace: p.hot.content.avgPaceSKm,
      hr: p.hot.content.avgHr,
      feelsLike: p.hot.content.feelsLike,
      distanceM: p.hot.content.distanceM,
    },
    cool: {
      sourceId: p.cool.id,
      day: day(p.cool),
      pace: p.cool.content.avgPaceSKm,
      hr: p.cool.content.avgHr,
      feelsLike: p.cool.content.feelsLike,
      distanceM: p.cool.content.distanceM,
    },
    hrDelta: p.hrDelta,
  });
  if (pairs.length)
    add(
      "comparison-weather",
      "相近配速和距离下的天气对照",
      `找到 ${pairs.length} 对不复用活动的配对，较热一侧的平均心率差为 ${pairs.map((p) => `${p.hrDelta >= 0 ? "+" : ""}${p.hrDelta}`).join("、")} bpm。`,
      "环境与心率反应",
      eligible.flatMap((p) => [p.hot, p.cool]),
      {
        selected: pairs.map(pairView),
        allEligible: eligible.map(pairView),
        selection:
          "同厂商、相同已知城市标签、户外easy、5–18km、爬升<5m/km、相隔1–21天、配速差≤5s/km、距离比≤1.3、体感温差≥5°C；先最小配速差，再日期距离；不按心率结果选样本。城市标签不等于同一路线。",
      },
      "探索性配对，不同路线、训练适应、前序负荷等仍可影响心率。此项作为初步关联，适合软性执行提示，不产生每摄氏度修正系数。",
    );
  const raceRows = runs.filter((e) => e.content.strideSessionClass === "race" && day(e) >= addDays(snapshot.endDay, -55));
  const raceContext = raceRows.map((e) => ({
    sourceId: e.id,
    day: day(e),
    name: e.content.name,
    distanceM: e.content.distanceM,
    paceSKm: e.content.avgPaceSKm,
    segments: segments(e).map((l) => ({ distanceM: l.distanceM, paceSKm: round((l.durationS / l.distanceM) * 1000), hr: l.hr })),
  }));
  if (raceContext.length && longRuns.length)
    add(
      "comparison-race-training",
      "测试表现与同期长跑的对照",
      "近期测试的平均成绩与分段过程，与同期长跑执行记录同时保留，供判断单次成绩是否适合独占能力锚点。",
      "比赛执行与能力表达",
      [...raceRows, ...longSources],
      { races: raceContext, longRuns },
      "只描述实测差异；不能从一次测试推断心理、伤病或确定的掉速原因。",
    );
  return {
    observations,
    diagnostics: {
      selectedLongRuns: longRuns.length,
      excludedLongRuns: longRows.filter((e) => !longSources.includes(e)).map((e) => e.id),
      eligibleWeatherPairs: eligible.length,
      selectedWeatherPairs: pairs.length,
    },
  };
}
