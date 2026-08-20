import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createWeeklyFeedbackSource,
	LegacyFileWeeklyFeedbackSource,
	MySqlWeeklyFeedbackSource,
	weeklyFeedbackCutoverComplete,
} from "./weeklyFeedbackSource.js";

test("weekly feedback cutover only accepts an explicit true marker", () => {
	assert.equal(weeklyFeedbackCutoverComplete(undefined), false);
	assert.equal(weeklyFeedbackCutoverComplete("false"), false);
	assert.equal(weeklyFeedbackCutoverComplete(" TRUE "), true);
});

test("weekly feedback source follows the cutover marker", () => {
	const store = {
		async getWeeklyFeedbackByDateRange() {
			return [];
		},
	};
	assert.ok(
		createWeeklyFeedbackSource(store, { cutoverComplete: false }) instanceof
			LegacyFileWeeklyFeedbackSource,
	);
	assert.ok(
		createWeeklyFeedbackSource(store, { cutoverComplete: true }) instanceof
			MySqlWeeklyFeedbackSource,
	);
});

test("MySQL feedback source delegates the bounded range", async () => {
	const calls: unknown[][] = [];
	const source = new MySqlWeeklyFeedbackSource({
		async getWeeklyFeedbackByDateRange(...args) {
			calls.push(args);
			return [];
		},
	});

	assert.deepEqual(
		await source.getByDateRange("athlete", "2026-06-01", "2026-06-30"),
		[],
	);
	assert.deepEqual(calls, [["athlete", "2026-06-01", "2026-06-30"]]);
});

test("legacy feedback source uses completed weeks, not unstable file mtimes", async (t) => {
	const dataDir = await mkdtemp(join(tmpdir(), "coach-feedback-"));
	t.after(() => rm(dataDir, { recursive: true, force: true }));
	const logsDir = join(dataDir, "athlete-1", "logs");
	await Promise.all([
		mkdir(join(logsDir, "2026-05-25_05-31(P1W4)"), { recursive: true }),
		mkdir(join(logsDir, "2026-06-01_06-07(P2W1)"), { recursive: true }),
		mkdir(join(logsDir, "2026-06-08_06-14(P2W2)"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(
			join(logsDir, "2026-05-25_05-31(P1W4)", "feedback.md"),
			"too old",
		),
		writeFile(
			join(logsDir, "2026-06-01_06-07(P2W1)", "feedback.md"),
			"first week",
		),
		writeFile(
			join(logsDir, "2026-06-08_06-14(P2W2)", "feedback.md"),
			"second week",
		),
	]);
	await Promise.all([
		utimes(
			join(logsDir, "2026-05-25_05-31(P1W4)", "feedback.md"),
			new Date("2026-05-31T00:00:00Z"),
			new Date("2026-05-31T00:00:00Z"),
		),
		utimes(
			join(logsDir, "2026-06-01_06-07(P2W1)", "feedback.md"),
			new Date("2026-07-01T00:00:00Z"),
			new Date("2026-07-01T00:00:00Z"),
		),
		utimes(
			join(logsDir, "2026-06-08_06-14(P2W2)", "feedback.md"),
			new Date("2026-06-01T00:00:00Z"),
			new Date("2026-06-01T00:00:00Z"),
		),
	]);

	const rows = await new LegacyFileWeeklyFeedbackSource(dataDir).getByDateRange(
		"athlete-1",
		"2026-06-01",
		"2026-06-08",
	);

	assert.deepEqual(
		rows.map(({ weekStart, contentMd }) => ({ weekStart, contentMd })),
		[{ weekStart: "2026-06-01", contentMd: "first week" }],
	);
	assert.ok(rows.every((row) => row.updatedAt === null));
});

test("legacy feedback source rejects unsafe user paths", async () => {
	const source = new LegacyFileWeeklyFeedbackSource("/tmp");
	await assert.rejects(
		() => source.getByDateRange("../athlete", "2026-06-01", "2026-06-08"),
		/invalid weekly feedback user id/,
	);
});
