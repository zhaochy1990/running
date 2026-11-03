// 抽奖落地页入口参数与时间窗展示 —— devops#868（Epic #862 P5）。
// 易拉宝小程序码双入口：query 直参 ?a=<活动ID>&s=<点位号>，或 scene
// （decodeURIComponent 后形如 `a=xx&s=yy`，coach-share 同款先例）。
// 纯逻辑收敛在此（自检 utils/lotteryScene.check.mts 进 npm test 链）。

import { fmtShanghaiMdHm } from './format';
import type { LotteryStatus } from '../services/lottery';

/** 解析出的入口参数：a=活动 ID（数字串），s=点位号（可空，看板按点位复盘用）。 */
export interface LotteryEntry {
  a: string;
  s: string;
}

/** 与后端 ACTIVITY_ID_RE（/^\d{1,15}$/）同口径：路径参数只认数字活动 ID。 */
const ACTIVITY_ID_RE = /^\d{1,15}$/;

/** 从 scene 查询串（`a=xx&s=yy`）里取指定键的值；缺失返回空串。 */
function sceneQueryValue(scene: string, key: string): string {
  for (const pair of scene.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() === key) {
      return pair.slice(eq + 1).trim();
    }
  }
  return '';
}

/**
 * 双入口参数解析：onLoad 的 options.a 直参优先；无直参则解析 options.scene
 * （decodeURIComponent，坏百分号编码时回落原串再试，coach-share 同款容错）。
 * 无有效活动 ID 返回 null（页面出 notfound 空态）。
 */
export function parseLotteryEntry(options: Record<string, string | undefined>): LotteryEntry | null {
  const direct = String(options.a ?? '').trim();
  if (ACTIVITY_ID_RE.test(direct)) {
    return { a: direct, s: String(options.s ?? '').trim() };
  }
  const rawScene = options.scene;
  if (!rawScene) return null;
  let scene = rawScene;
  try {
    scene = decodeURIComponent(rawScene);
  } catch {
    // 坏编码：保留原串再试
  }
  const sceneA = sceneQueryValue(scene, 'a');
  if (ACTIVITY_ID_RE.test(sceneA)) {
    return { a: sceneA, s: sceneQueryValue(scene, 's') };
  }
  return null;
}

/** 时间窗展示（上海墙钟 MM-DD HH:mm ~ MM-DD HH:mm）。 */
export function lotteryWindow(startIso: string, endIso: string): string {
  return `${fmtShanghaiMdHm(startIso)} ~ ${fmtShanghaiMdHm(endIso)}`;
}

export interface LotteryPhaseMeta {
  /** 状态章文案：未开始 / 进行中 / 已结束 */
  label: string;
  /** 提示行：未开始给开始时刻，进行中 / 已结束给完整时间窗。 */
  hint: string;
}

/** 活动时间窗状态 → 状态章 + 提示行。 */
export function lotteryPhaseMeta(status: LotteryStatus, startIso: string, endIso: string): LotteryPhaseMeta {
  if (status === 'not_started') {
    return { label: '未开始', hint: `${fmtShanghaiMdHm(startIso)} 开始` };
  }
  const window = lotteryWindow(startIso, endIso);
  return status === 'active'
    ? { label: '进行中', hint: window }
    : { label: '已结束', hint: window };
}
