import type { Activity } from "./dataStore.js";

type ActivityClassificationInput = Pick<
	Activity,
	"name" | "sport" | "sportName" | "sportNote" | "trainKind"
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
			activity.trainKind ?? "",
		)
	)
		return true;
	const description = [activity.name, activity.sportNote]
		.filter((value): value is string => value !== null)
		.join(" ");
	const mentionsPaceAbbreviation = description
		.toUpperCase()
		.split(/[^A-Z]+/)
		.some((token) => token === "MP" || token === "HMP");
	return (
		mentionsPaceAbbreviation ||
		/interval|tempo|threshold|speed|vo2max|race[_ -]?pace|marathon[_ -]?pace|间歇|阈值|节奏|马拉松配速|马配/i.test(
			description,
		)
	);
}
