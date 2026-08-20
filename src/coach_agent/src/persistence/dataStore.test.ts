import assert from "node:assert/strict";
import test from "node:test";
import { StrideDataStore } from "./dataStore.js";

test("getVendorHrvBaseline reads the latest non-null daily vendor band", async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const store = new StrideDataStore({
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
		await store.getVendorHrvBaseline("athlete-1", "2026-08-19"),
		{
			low: 28,
			high: 36,
			provider: "coros",
			date: "2026-08-19",
		},
	);
	assert.deepEqual(calls[0]?.values, ["athlete-1", "2026-08-19"]);
	assert.match(calls[0]?.sql ?? "", /baseline_balanced_low IS NOT NULL/);
	assert.match(calls[0]?.sql ?? "", /JOIN dashboard/);
	assert.match(calls[0]?.sql ?? "", /REPLACE\(h.date, '-', ''\) <=/);
});
