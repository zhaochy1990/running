import assert from "node:assert/strict";
import test from "node:test";
import { planningStartDate, shanghaiDay } from "./planningDate.js";

test("planning start is the first Monday on or after asof", () => {
	assert.equal(planningStartDate("2026-05-04"), "2026-05-04");
	assert.equal(planningStartDate("2026-05-05"), "2026-05-11");
	assert.equal(planningStartDate("2026-05-10"), "2026-05-11");
	assert.equal(planningStartDate("2026-12-31"), "2027-01-04");
});

test("Shanghai day preserves calendar dates and normalizes instants", () => {
	assert.equal(shanghaiDay("2026-05-01"), "2026-05-01");
	assert.equal(shanghaiDay("2026-05-01T16:30:00Z"), "2026-05-02");
	assert.throws(() => shanghaiDay("2026-02-30"), /invalid Shanghai date/);
});
