import assert from "node:assert/strict";
import test from "node:test";
import { MySqlDataProvider } from "./mysqlDataProvider.js";

test("getVendorHrvBaseline reads the latest non-null daily vendor band", async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const provider = new MySqlDataProvider({
		async query(sql: string, values: unknown[]) {
			calls.push({ sql, values });
			return [
				[
					{
						date: "20260819",
						baseline_balanced_low: 28,
						baseline_balanced_upper: 36,
						provider: "coros",
					},
				],
			];
		},
	} as never);

	assert.deepEqual(
		await provider.getVendorHrvBaseline("athlete-1", "2026-08-19"),
		{ low: 28, high: 36, provider: "coros", date: "2026-08-19" },
	);
	assert.deepEqual(calls[0]?.values, ["athlete-1", "2026-08-19"]);
	assert.match(calls[0]?.sql ?? "", /baseline_balanced_low IS NOT NULL/);
	assert.match(calls[0]?.sql ?? "", /JOIN dashboard/);
	assert.match(calls[0]?.sql ?? "", /REPLACE\(h.date, '-', ''\) <=/);
});

test("personal best loader preserves label ID and decimal precision contract", async () => {
	let sql = "";
	const provider = new MySqlDataProvider({
		async query(query: string) {
			sql = query;
			return [
				[
					{
						distance: "5K",
						pb_time_sec: "1170.34",
						achieved_at: "2026-05-27",
						activity_label_id: "activity-5k-pb",
					},
				],
			];
		},
	} as never);
	assert.deepEqual(await provider.getPersonalBests("athlete"), [
		{
			distance: "5K",
			timeSec: 1170.3,
			achievedAt: "2026-05-27",
			activityLabelId: "activity-5k-pb",
		},
	]);
	assert.match(sql, /entry_json, '\$\.label_id'/);
});

test("plan reads are scoped to user, active version, and week start", async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const provider = new MySqlDataProvider({
		async query(sql: string, values: unknown[]) {
			calls.push({ sql, values });
			return [[{ content: JSON.stringify({ id: calls.length }) }]];
		},
	} as never);
	assert.deepEqual(await provider.getMasterPlan("athlete"), { id: 1 });
	assert.deepEqual(
		await provider.getWeeklyPlan("athlete", "2026-07-20_07-26"),
		{ id: 2 },
	);
	const [masterCall, weeklyCall] = calls;
	assert.ok(masterCall);
	assert.ok(weeklyCall);
	assert.match(
		masterCall.sql,
		/user_id = \? AND content_version = 2 AND status = 'active'/,
	);
	assert.deepEqual(masterCall.values, ["athlete"]);
	assert.deepEqual(weeklyCall.values, ["athlete", "2026-07-20"]);
});

test("running calibration omits zone confidence and speed details", async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const provider = new MySqlDataProvider({
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
			if (sql.includes("pace_zone"))
				return [
					[
						{
							name: "threshold",
							min_pace_s_per_km: 270,
							max_pace_s_per_km: 250,
						},
					],
				];
			return [[{ name: "threshold", min_bpm: 160, max_bpm: 170 }]];
		},
	} as never);
	assert.deepEqual(
		(await provider.getLatestRunningCalibration("athlete"))?.paceZones,
		[{ name: "threshold", minPaceSPerKm: 270, maxPaceSPerKm: 250 }],
	);
	for (const sql of calls.slice(1).map((call) => call.sql)) {
		assert.doesNotMatch(sql, /confidence|min_speed_mps|max_speed_mps/);
	}
});
