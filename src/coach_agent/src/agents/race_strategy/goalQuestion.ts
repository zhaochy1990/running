import type { RaceCalendarContext, RaceTarget } from "../../data/dataProvider.js";

/** 目标完赛时间的「明确」口径：H:MM 或 H:MM:SS（race_goal 存 h:mm:ss）。 */
const CLEAR_TARGET_TIME = /^\d{1,2}:\d{2}(:\d{2})?$/;

/** race_goal.race_distance 词汇与 race_calendar_item.type 的对应（与前端 goalDistanceOf 同口径）。 */
const DISTANCE_BY_ITEM_TYPE: Record<string, string> = {
  Marathon: "FM",
  HalfMarathon: "HM",
  "10 Km": "10K",
  "5 Km": "5K",
};

/**
 * 追问目标成绩的一句话文案。有已存的比赛目标且能对上本场（同比赛日 + 同项目
 * 词汇 + 时间可读）时，带着该目标发起确认；否则一句话直接问。匹配从严：
 * 对不上宁可直问，绝不把别的比赛的目标安到这场头上。
 */
export function raceGoalQuestion(input: {
  goal: RaceTarget | null;
  race: Pick<RaceCalendarContext, "name" | "name_cn" | "race_date"> | null;
  itemType: string;
}): string {
  const goal = matchingGoal(input);
  if (goal !== null) {
    return `我查到你之前的比赛目标是 ${goal}，需要我按照这个目标帮你制定比赛策略吗？`;
  }
  return "你这场比赛的目标成绩是多少？";
}

/** 对得上本场且时间明确的目标时间；对不上返回 null（追问走直问分支）。 */
function matchingGoal({
  goal,
  race,
  itemType,
}: {
  goal: RaceTarget | null;
  race: Pick<RaceCalendarContext, "name" | "name_cn" | "race_date"> | null;
  itemType: string;
}): string | null {
  if (goal === null || race === null) return null;
  if (goal.race_date !== race.race_date.slice(0, 10)) return null;
  // 未知项目词汇映射不了距离，无从核对，从严按对不上处理。
  if (goal.race_distance !== DISTANCE_BY_ITEM_TYPE[itemType]) return null;
  // 列可空：TS 类型是 string，运行时可能拿到 null。
  if (typeof goal.target_finish_time !== "string") return null;
  const time = goal.target_finish_time.trim();
  return CLEAR_TARGET_TIME.test(time) ? time : null;
}
