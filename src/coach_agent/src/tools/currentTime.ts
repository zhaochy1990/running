import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import { defineCoachTools } from "./common.js";

const getCurrentTimeSchema = z.object({});

function weekNameForShanghaiDate(date: string): string {
	const shanghaiMidnight = new Date(`${date}T00:00:00Z`);
	const monday = new Date(shanghaiMidnight);
	monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
	const sunday = new Date(monday);
	sunday.setUTCDate(sunday.getUTCDate() + 6);
	return `${monday.toISOString().slice(0, 10)}_${sunday.toISOString().slice(5, 10)}`;
}

function shanghaiDate(now: Date): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(now);
	const value = (type: string) =>
		parts.find((part) => part.type === type)!.value;
	return `${value("year")}-${value("month")}-${value("day")}`;
}

export function createCurrentTimeTools(
	now: Date = new Date(),
): StructuredTool[] {
	return defineCoachTools([
		{
			name: "get_current_time",
			description:
				"获取当前上海时间，以及本周和下周的规范 weekName。处理“今天”“本周”“下周”等相对日期请求前必须调用此工具；返回值是唯一可信的时间依据。",
			schema: getCurrentTimeSchema,
			handler: () => {
				const today = shanghaiDate(now);
				const currentWeek = weekNameForShanghaiDate(today);
				const nextMonday = new Date(`${currentWeek.slice(0, 10)}T00:00:00Z`);
				nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
				const nextWeek = weekNameForShanghaiDate(
					nextMonday.toISOString().slice(0, 10),
				);
				return {
					timezone: "Asia/Shanghai",
					today,
					current_week: currentWeek,
					next_week: nextWeek,
				};
			},
		},
	]);
}
