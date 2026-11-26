// 我的成绩行模型的纯变换 —— 不依赖小程序运行时，
// 配套 utils/raceResultRows.check.mts 自检
// （`node --import ./utils/ts-resolve-hooks.mjs utils/raceResultRows.check.mts`）。

import type { RaceItem } from '../services/races';
import { shanghaiDateFromIso } from './date';
import { daysUntil } from './raceDetailRows';
import { countdownLabel } from './racePlanRows';

/** 成绩行显示上海比赛日期及已过天数。 */
export function raceResultDateLabels(date: string, today: string): { dateLabel: string; elapsedLabel: string } {
  const raceDate = shanghaiDateFromIso(date);
  const days = daysUntil(raceDate, today);
  return {
    dateLabel: raceDate || date,
    elapsedLabel: days < 0 ? countdownLabel(days) : '',
  };
}

/**
 * 成绩行显示名解析链（devops#545）：官方赛名 → 手输名 → 活动名。
 * 返回 ''（三层皆空）时由调用方兜底距离档文案。
 */
export function raceDisplayName(
  race: Pick<RaceItem, 'race_name' | 'display_name' | 'name'>,
): string {
  return race.race_name || race.display_name || race.name || '';
}

/** PATCH display_name 成功后就地刷新内存行（devops#561）：空名 = 清除（null）。 */
export function applyRaceRename(raw: RaceItem, name: string): RaceItem {
  return { ...raw, display_name: name || null };
}
