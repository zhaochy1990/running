import type { Activity } from "./dataProvider.js";

type ActivityClassificationInput = Pick<
	Activity,
	"name" | "sport" | "sportName" | "sportNote" | "strideSessionClass"
>;

/** Shared classification for watch-synced running activities. */
export function isRunningActivity(
	activity: ActivityClassificationInput,
): boolean {
	return (
		activity.sport?.toLowerCase().startsWith("run") === true ||
		activity.sportName?.toLowerCase().includes("run") === true
	);
}

/** Keep master- and weekly-plan contexts on the same quality definition. */
export function isQualityRunningActivity(
	activity: ActivityClassificationInput,
): boolean {
	if (!isRunningActivity(activity)) return false;
	if (
		/interval|tempo|threshold|speed|sprint|vo2|max|anaerobic|race|race[_ -]?pace|marathon[_ -]?pace/i.test(
			activity.strideSessionClass ?? "",
		)
	)
		return true;
	const name = activity.name ?? "";
	if (
		/race|marathon|比赛|马拉松/i.test(name) ||
		/hill(?: repeats?| sprints?)|坡跑|爬坡间歇/i.test(name)
	)
		return true;
	const description = [name, activity.sportNote]
		.filter((value): value is string => value !== null)
		.join(" ");
	const mentionsPaceAbbreviation = description
		.toUpperCase()
		.split(/[^A-Z]+/)
		.some((token) => token === "MP" || token === "HMP");
	return (
		mentionsPaceAbbreviation ||
		/interval|tempo|threshold|speed|vo2max|race[_ -]?pace|marathon[_ -]?pace|hill repeats?|坡跑|爬坡间歇|间歇|阈值|节奏|马拉松配速|马配/i.test(
			description,
		)
	);
}
