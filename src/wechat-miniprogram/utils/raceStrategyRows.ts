// 比赛策略报告页的纯视图模型 —— #396，配套 utils/raceStrategyRows.check.mts
// 自检（`node --import ./utils/ts-resolve-hooks.mjs utils/raceStrategyRows.check.mts`）。
// 页面（pages/race-center/strategy）负责请求与交互，这里只做
// 策略内容 → 可编辑行视图 的确定性变换，以及「用时=距离×配速」的自动换算、
// 分享文案与「设为目标」的 race_goal 预填映射。

import type { RaceStrategy, RacePaceSegment } from '../services/race-strategy';
import { typeAbbr } from './raceCenterRows';

/** 配速文本 '5:40/km' → 每公里秒数；解析不了返回 null。 */
export function parsePaceSPerKm(pace: string): number | null {
  const m = /^(\d{1,2}):([0-5]\d)(?:\/\s*km)?$/.exec(pace.trim());
  if (!m) return null;
  const sec = Number(m[1]) * 60 + Number(m[2]);
  return sec > 0 ? sec : null;
}

/** 每公里秒数 → '5:40/km'（分秒，秒两位）。 */
export function formatPace(sPerKm: number): string {
  const m = Math.floor(sPerKm / 60);
  const s = Math.round(sPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
}

/** 秒数 → 'h:mm:ss'（<1h 时 'mm:ss'，与教练口径一致）。 */
export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 分段配速表的可编辑行：segment/pace/note 手动编辑；times 自动算（距离已知时）。 */
export interface PaceRowView {
  index: number;
  /** 原始分段名（保存体往返用；模型可能写「0–3km 外滩起跑（…）」长描述）。 */
  segment: string;
  /** 分段名里的距离短标签（「0–3km」），无距离前缀时回落整段名。 */
  distance: string;
  /** 分段名去掉距离后的描述（「外滩起跑（…）」），可为空。 */
  desc: string;
  /** 距离 km；null=教练未给出（用时保持文本态，不自动换算）。 */
  distanceKm: number | null;
  pace: string;
  segmentTime: string;
  cumulativeTime: string;
  note: string;
}

/**
 * 拆分段名：模型常把地形/位置描述写进 segment（「0–3km 外滩起跑（中山东一
 * 路→新开河路收窄段）」），表格里距离列只放短标签，描述另起一行小字。
 * 匹配不到距离前缀时 distance=整段名、desc 为空（不丢内容）。
 */
export function splitSegmentName(segment: string): { distance: string; desc: string } {
  const m = /^([0-9]+(?:[.,][0-9]+)?\s*[–~\-—]+\s*[0-9]+(?:[.,][0-9]+)?\s*(?:km|公里)?|[0-9]+(?:[.,][0-9]+)?\s*(?:km|公里))\s*[：:、]?\s*(.*)$/i.exec(segment.trim());
  if (m === null) return { distance: segment.trim(), desc: '' };
  return { distance: m[1].replace(/\s+/g, ' ').trim(), desc: m[2].trim() };
}

/** 补给计划的可编辑行。 */
export interface FuelingRowView {
  index: number;
  timePoint: string;
  content: string;
}

/** 报告页整体视图模型。 */
export interface StrategyView {
  raceName: string;
  itemType: string;
  itemTypeLabel: string;
  targetTime: string;
  summary: string;
  paceRows: PaceRowView[];
  fuelingRows: FuelingRowView[];
  courseTips: string[];
  weatherTips: string;
  basisNote: string;
}

/** 「用时=距离×配速」：逐行换算本段用时并累计；距离缺失或配速解析不了的行保持原文本。 */
export function recomputePaceTimes(rows: PaceRowView[]): PaceRowView[] {
  let cumulative = 0;
  return rows.map((row, i) => {
    const pace = parsePaceSPerKm(row.pace);
    if (row.distanceKm != null && row.distanceKm > 0 && pace != null) {
      const seg = row.distanceKm * pace;
      cumulative += seg;
      return { ...row, index: i, segmentTime: formatDuration(seg), cumulativeTime: formatDuration(cumulative) };
    }
    return { ...row, index: i };
  });
}

/** 策略内容 → 报告页视图（自动换算后的分段表）。 */
export function toStrategyView(strategy: RaceStrategy): StrategyView {
  const paceRows: PaceRowView[] = strategy.pace_segments.map((seg: RacePaceSegment, i) => ({
    index: i,
    segment: seg.segment,
    ...splitSegmentName(seg.segment),
    distanceKm: seg.distance_km ?? null,
    pace: seg.pace,
    segmentTime: seg.segment_time,
    cumulativeTime: seg.cumulative_time,
    note: seg.note || '',
  }));
  return {
    raceName: strategy.race_name,
    itemType: strategy.item_type,
    itemTypeLabel: typeAbbr(strategy.item_type) || strategy.item_type,
    targetTime: strategy.target_finish_time,
    summary: strategy.summary,
    paceRows: recomputePaceTimes(paceRows),
    fuelingRows: strategy.fueling_plan.map((f, i) => ({
      index: i,
      timePoint: f.time_point,
      content: f.content,
    })),
    courseTips: strategy.course_tips || [],
    weatherTips: (strategy.weather_tips || []).join('\n'),
    basisNote: strategy.basis_note || '',
  };
}

/** 视图 → 保存体（编辑值回收；目标/总述等文本字段原样带回）。 */
export function fromStrategyView(view: StrategyView, base: RaceStrategy): RaceStrategy {
  const paceRows = recomputePaceTimes(view.paceRows);
  return {
    ...base,
    race_name: view.raceName,
    item_type: view.itemType,
    target_finish_time: view.targetTime,
    summary: view.summary,
    pace_segments: paceRows.map((row) => ({
      segment: row.segment,
      distance_km: row.distanceKm,
      pace: row.pace,
      segment_time: row.segmentTime,
      cumulative_time: row.cumulativeTime,
      note: row.note,
    })),
    fueling_plan: view.fuelingRows
      .filter((r) => r.timePoint.trim() || r.content.trim())
      .map((r) => ({ time_point: r.timePoint.trim(), content: r.content.trim() })),
  };
}

/** 分享标题：'我的杭马比赛策略 · 目标 3:59:59'。 */
export function strategyShareTitle(view: StrategyView): string {
  return `我的${view.raceName}比赛策略 · 目标 ${view.targetTime}`;
}

/** race_goal 的 race_distance 词汇（POST /training-goal oneof）：映射不了的 token 返回 null（按钮隐藏）。 */
export function goalDistanceOf(itemType: string): string | null {
  if (itemType === 'Marathon') return 'FM';
  if (itemType === 'HalfMarathon') return 'HM';
  if (/^10\s*Km$/i.test(itemType)) return '10K';
  if (/^5\s*Km$/i.test(itemType)) return '5K';
  return null;
}

/** 「设为目标」预填体（race_goal POST 的 race_* 字段；weekly_training_days 由用户选）。 */
export function goalPrefill(
  view: StrategyView,
  raceDate: string,
  raceLocation: string | null,
): { race_date: string; race_distance: string; race_name: string; target_finish_time: string; race_location: string | null } | null {
  const distance = goalDistanceOf(view.itemType);
  if (!distance) return null;
  return {
    race_date: raceDate,
    race_distance: distance,
    race_name: view.raceName,
    target_finish_time: view.targetTime,
    race_location: raceLocation,
  };
}

/** '2026-10-18T09:30:00Z' → '2026/10/18'（报告页头部的比赛日展示；非法输入原样返回）。 */
export function raceDayLabel(raceDate: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(raceDate) ? raceDate.slice(0, 10).replace(/-/g, '/') : raceDate;
}
