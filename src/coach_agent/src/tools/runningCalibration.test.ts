import assert from "node:assert/strict";
import test from "node:test";
import { StrideDataStore } from "../persistence/index.js";
import { createRunningCalibrationTools } from "./runningCalibration.js";

const userId = "athlete-1";

test("get_running_calibration returns the latest threshold and zones for the runtime user", async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const pool = {
		async query(sql: string, values: unknown[]) {
			calls.push({ sql, values });
			if (sql.includes("running_calibration_snapshot")) {
				return [
					[
						{
							id: 42,
							as_of_date: "2026-08-08",
							threshold_hr: 168,
							threshold_speed_mps: 3.9,
							threshold_hr_confidence: "high",
							threshold_speed_confidence: "medium",
						},
					],
				];
			}
			if (sql.includes("running_calibration_pace_zone")) {
				return [
					[
						{
							name: "threshold",
							min_pace_s_per_km: 270,
							max_pace_s_per_km: 250,
							min_speed_mps: 3.7,
							max_speed_mps: 4,
							confidence: "medium",
						},
					],
				];
			}
			return [
				[{ name: "threshold", min_bpm: 160, max_bpm: 170, confidence: "high" }],
			];
		},
	};
	const [tool] = createRunningCalibrationTools(
		new StrideDataStore(pool as never),
	);

	assert.ok(tool);
	assert.equal(tool.name, "get_running_calibration");
	assert.deepEqual(await tool.invoke({}, { context: { userId } }), {
		asOfDate: "2026-08-08",
		thresholdHr: 168,
		thresholdSpeedMps: 3.9,
		thresholdHrConfidence: "high",
		thresholdSpeedConfidence: "medium",
		paceZones: [
			{
				name: "threshold",
				minPaceSPerKm: 270,
				maxPaceSPerKm: 250,
			},
		],
		heartRateZones: [{ name: "threshold", minBpm: 160, maxBpm: 170 }],
	});
	assert.deepEqual(
		calls.map((call) => call.values),
		[[userId], [userId, 42], [userId, 42]],
	);
	const zoneQueries = calls.slice(1).map((call) => call.sql);
	for (const field of ["confidence", "min_speed_mps", "max_speed_mps"]) {
		assert.ok(zoneQueries.every((sql) => !sql.includes(field)));
	}
});

test("get_running_calibration returns null without a computed calibration", async () => {
	const pool = {
		async query() {
			return [[]];
		},
	};
	const [tool] = createRunningCalibrationTools(
		new StrideDataStore(pool as never),
	);

	assert.ok(tool);
	assert.equal(await tool.invoke({}, { context: { userId } }), null);
	await assert.rejects(() => tool.invoke({}, {}), /missing userId/);
});
