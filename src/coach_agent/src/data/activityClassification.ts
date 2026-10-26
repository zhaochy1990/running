import type { Activity } from "./dataProvider.js";

type ActivityClassificationInput = Pick<Activity, "name" | "sport" | "sportName" | "sportNote" | "strideSessionClass">;

/**
 * session_class values that count as a quality session. The Go writer emits the
 * post-#745 taxonomy (quality/long_quality/race); tempo/interval are the legacy
 * values stored before the enum upgrade and stay recognised forever — rows
 * older than the 365-day compute window are never rewritten, so mixed old/new
 * data is the steady state, not a transition. strides is deliberately absent:
 * strides are a supplement, not a quality session (Daniels).
 */
export const QUALITY_SESSION_CLASSES = new Set(["quality", "long_quality", "race", "tempo", "interval"]);

/**
 * Fold a legacy session_class onto the post-#745 taxonomy: tempo/interval →
 * quality, long → long_easy. Everything else (including the new values) passes
 * through unchanged, as do null and unrecognised strings — this is a grouping
 * key, not a validator.
 */
export function normalizeSessionClass(value: string | null): string | null {
  if (value === "tempo" || value === "interval") return "quality";
  if (value === "long") return "long_easy";
  return value;
}

/** Shared classification for watch-synced running activities. */
export function isRunningActivity(activity: ActivityClassificationInput): boolean {
  return activity.sport?.toLowerCase().startsWith("run") === true || activity.sportName?.toLowerCase().includes("run") === true;
}

/**
 * 周画像口径的跑步行判定（evidence 月度画像与 L3 habitual 周序列共用）：
 * 有厂商 sport 信息按 isRunningActivity 同判据（骑行等不入画像），无则退回
 * >2km 距离阈值。入参取结构子集（sport/sportName 可缺省），两种活动投影都可直接过滤。
 */
export function isRunLikeActivity(activity: { name?: string | null; sport?: string | null; sportName?: string | null; distanceM?: number | null }): boolean {
  return activity.sport != null || activity.sportName != null
    ? activity.sport!.toLowerCase().startsWith("run") === true || activity.sportName!.toLowerCase().includes("run") === true
    : (activity.distanceM ?? 0) > 2000;
}

/** Keep master- and weekly-plan contexts on the same quality definition. */
export function isQualityRunningActivity(activity: ActivityClassificationInput): boolean {
  if (!isRunningActivity(activity)) return false;
  if (activity.strideSessionClass !== null && QUALITY_SESSION_CLASSES.has(activity.strideSessionClass)) return true;
  const name = activity.name ?? "";
  if (/race|marathon|比赛|马拉松/i.test(name) || /hill(?: repeats?| sprints?)|坡跑|爬坡间歇/i.test(name)) return true;
  const description = [name, activity.sportNote].filter((value): value is string => value !== null).join(" ");
  const mentionsPaceAbbreviation = description
    .toUpperCase()
    .split(/[^A-Z]+/)
    .some((token) => token === "MP" || token === "HMP");
  return (
    mentionsPaceAbbreviation ||
    /interval|tempo|threshold|speed|vo2max|race[_ -]?pace|marathon[_ -]?pace|hill repeats?|坡跑|爬坡间歇|间歇|阈值|节奏|马拉松配速|马配/i.test(description)
  );
}
