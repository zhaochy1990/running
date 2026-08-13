import assert from "node:assert/strict";
import test from "node:test";
import type { DataProvider } from "../data/dataProvider.js";
import { createRunningCalibrationTools } from "./runningCalibration.js";

const userId = "athlete-1";

test("get_running_calibration returns the latest threshold and zones for the runtime user", async () => {
	const provider = {
		async getLatestRunningCalibration(
			requestUserId: string,
			asOfDate: string,
		) {
			assert.equal(requestUserId, userId);
			assert.equal(asOfDate, "2026-08-14");
			return {
				asOfDate: "2026-08-08",
				thresholdHr: 168,
				thresholdSpeedMps: 3.9,
				rhrBaseline: 48,
				thresholdHrConfidence: "high",
				thresholdSpeedConfidence: "medium",
				paceZones: [
					{ name: "threshold", minPaceSPerKm: 270, maxPaceSPerKm: 250 },
				],
				heartRateZones: [{ name: "threshold", minBpm: 160, maxBpm: 170 }],
			};
		},
	} as DataProvider;
	const [tool] = createRunningCalibrationTools(provider);

	assert.ok(tool);
	assert.equal(tool.name, "get_running_calibration");
	assert.deepEqual(
		await tool.invoke({}, { context: { userId, asof: "2026-08-14" } }),
		{
		asOfDate: "2026-08-08",
		thresholdHr: 168,
		thresholdSpeedMps: 3.9,
		rhrBaseline: 48,
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
		},
	);
});

test("get_running_calibration returns null without a computed calibration", async () => {
	const provider = {
		async getLatestRunningCalibration() {
			return null;
		},
	} as unknown as DataProvider;
	const [tool] = createRunningCalibrationTools(provider);

	assert.ok(tool);
	assert.equal(
		await tool.invoke({}, { context: { userId, asof: "2026-08-14" } }),
		null,
	);
	await assert.rejects(() => tool.invoke({}, {}), /missing userId/);
	await assert.rejects(
		() => tool.invoke({}, { context: { userId } }),
		/missing asof/,
	);
});
