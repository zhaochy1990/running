import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addDays, shanghaiDay } from "@stride/contract";
import type { DataProvider, WeeklyFeedback } from "./dataProvider.js";

export interface WeeklyFeedbackSource {
	getByDateRange(
		userId: string,
		startDay: string,
		endDay: string,
	): Promise<WeeklyFeedbackRecord[]>;
}

export type WeeklyFeedbackRecord = Omit<WeeklyFeedback, "updatedAt"> & {
	updatedAt: Date | null;
};

type MySqlFeedbackStore = Pick<DataProvider, "getWeeklyFeedbackByDateRange">;

export interface WeeklyFeedbackSourceOptions {
	cutoverComplete?: boolean;
	legacyDataDir?: string;
}

export function createWeeklyFeedbackSource(
	store: MySqlFeedbackStore,
	options: WeeklyFeedbackSourceOptions = {},
): WeeklyFeedbackSource {
	const cutoverComplete =
		options.cutoverComplete ?? weeklyFeedbackCutoverComplete();
	return cutoverComplete
		? new DataProviderWeeklyFeedbackSource(store)
		: new LegacyFileWeeklyFeedbackSource(options.legacyDataDir);
}

export class DataProviderWeeklyFeedbackSource implements WeeklyFeedbackSource {
	constructor(private readonly store: MySqlFeedbackStore) {}

	getByDateRange(
		userId: string,
		startDay: string,
		endDay: string,
	): Promise<WeeklyFeedbackRecord[]> {
		return this.store.getWeeklyFeedbackByDateRange(userId, startDay, endDay);
	}
}

export class LegacyFileWeeklyFeedbackSource implements WeeklyFeedbackSource {
	constructor(private readonly dataDir = defaultDataDir()) {}

	async getByDateRange(
		userId: string,
		startDay: string,
		endDay: string,
	): Promise<WeeklyFeedbackRecord[]> {
		assertUserId(userId);
		assertRange(startDay, endDay);
		const logsDir = join(this.dataDir, userId, "logs");
		let entries: Dirent[];
		try {
			entries = await readdir(logsDir, { withFileTypes: true });
		} catch (error) {
			if (isMissing(error)) return [];
			throw error;
		}

		const rows = await Promise.all(
			entries
				.filter((entry) => entry.isDirectory())
				.map(async (entry): Promise<WeeklyFeedbackRecord | null> => {
					const weekStart = weekStartFromFolder(entry.name);
					if (
						!weekStart ||
						weekStart < startDay ||
						addDays(weekStart, 6) > endDay
					) {
						return null;
					}
					const path = join(logsDir, entry.name, "feedback.md");
					try {
						const contentMd = await readFile(path, "utf8");
						return { weekStart, contentMd, updatedAt: null };
					} catch (error) {
						if (isMissing(error)) return null;
						throw error;
					}
				}),
		);
		return rows
			.filter((row): row is WeeklyFeedbackRecord => row !== null)
			.sort((left, right) => left.weekStart.localeCompare(right.weekStart));
	}
}

export function weeklyFeedbackCutoverComplete(
	value = process.env.STRIDE_WEEKLY_FEEDBACK_CUTOVER_COMPLETE,
): boolean {
	return value?.trim().toLowerCase() === "true";
}

function defaultDataDir(): string {
	return (
		process.env.STRIDE_COACH_DATA_DIR ??
		resolve(dirname(fileURLToPath(import.meta.url)), "../../../..", "data")
	);
}

function weekStartFromFolder(folder: string): string | null {
	const match = /^(\d{4}-\d{2}-\d{2})_/.exec(folder);
	if (!match?.[1]) return null;
	try {
		return shanghaiDay(match[1]);
	} catch {
		return null;
	}
}

function assertRange(startDay: string, endDay: string): void {
	const start = shanghaiDay(startDay);
	const end = shanghaiDay(endDay);
	if (start !== startDay || end !== endDay || start > end) {
		throw new Error(`invalid weekly feedback range: ${startDay}..${endDay}`);
	}
}

function assertUserId(userId: string): void {
	if (!/^[A-Za-z0-9_-]+$/.test(userId)) {
		throw new Error(`invalid weekly feedback user id: ${userId}`);
	}
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
