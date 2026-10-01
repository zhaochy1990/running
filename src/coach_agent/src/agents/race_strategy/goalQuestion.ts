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

/** active master plan 的 content.goal 投影；content 是 Record<string, unknown>，逐字段防御。 */
export interface MasterPlanGoalSnapshot {
  race_date: string;
  distance: string;
  target_time: string | null;
}

/** 从 master plan 文档防御式取 goal 快照（同一场比赛日 + 距离 + 目标时间）；形状不对返回 null。 */
export function masterPlanGoalFromDocument(content: unknown): MasterPlanGoalSnapshot | null {
  if (content === null || typeof content !== "object") return null;
  const goal = (content as Record<string, unknown>).goal;
  if (goal === null || typeof goal !== "object") return null;
  const { race_date: raceDate, distance, target_time: targetTime } = goal as Record<string, unknown>;
  if (typeof raceDate !== "string" || typeof distance !== "string") return null;
  if (targetTime !== null && typeof targetTime !== "string") return null;
  return { race_date: raceDate, distance, target_time: targetTime };
}

/**
 * 追问目标成绩的一句话文案。候选目标按序查两处：已存的比赛目标（race_goal）
 * 与 active 赛季训练计划的目标（master plan content.goal）——都能对上本场
 * （同比赛日 + 同项目词汇 + 时间可读）时：一个候选带目标确认，两个不同候选
 * 列出让运动员选，都没有则一句话直接问。匹配从严：对不上宁可直问，绝不把
 * 别的比赛的目标安到这场头上。
 */
export function raceGoalQuestion(input: {
  goal: RaceTarget | null;
  /** active master plan 的目标快照；不传 / null 表示没有可用的计划目标。 */
  planGoal?: MasterPlanGoalSnapshot | null;
  race: Pick<RaceCalendarContext, "name" | "name_cn" | "race_date"> | null;
  itemType: string;
}): string {
  const race = input.race;
  const times: string[] = [];
  // race_goal 在前（运动员最新声明的目标），master plan 在后；同值去重——
  // 计划由目标生成，两者一致是常态，不能问用户「选哪个」。
  if (race !== null) {
    collect(matchingTime(goalCandidate(input.goal), race, input.itemType), times);
    collect(matchingTime(input.planGoal ?? null, race, input.itemType), times);
  }
  if (times.length === 0) return "你这场比赛的目标成绩是多少？";
  if (times.length === 1) {
    return `我查到你之前的比赛目标是 ${times[0]}，需要我按照这个目标帮你制定比赛策略吗？`;
  }
  return `我查到你的比赛目标是 ${times[0]}，赛季训练计划的目标是 ${times[1]}，要按哪个目标帮你制定这场比赛的策略？`;
}

function goalCandidate(goal: RaceTarget | null): MasterPlanGoalSnapshot | null {
  if (goal === null) return null;
  return { race_date: goal.race_date, distance: goal.race_distance, target_time: goal.target_finish_time };
}

function collect(time: string | null, times: string[]): void {
  if (time !== null && !times.includes(time)) times.push(time);
}

/** 对得上本场且时间明确的目标时间；对不上返回 null（不进候选）。 */
function matchingTime(
  candidate: MasterPlanGoalSnapshot | null,
  race: Pick<RaceCalendarContext, "name" | "name_cn" | "race_date">,
  itemType: string,
): string | null {
  if (candidate === null) return null;
  if (candidate.race_date !== race.race_date.slice(0, 10)) return null;
  // 未知项目词汇映射不了距离，无从核对，从严按对不上处理。
  if (candidate.distance !== DISTANCE_BY_ITEM_TYPE[itemType]) return null;
  // 列可空：TS 类型是 string，运行时可能拿到 null。
  if (typeof candidate.target_time !== "string") return null;
  const time = candidate.target_time.trim();
  return CLEAR_TARGET_TIME.test(time) ? time : null;
}
