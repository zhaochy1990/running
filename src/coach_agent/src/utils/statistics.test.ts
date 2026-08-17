import assert from "node:assert/strict";
import test from "node:test";
import { median } from "./statistics.js";

test("median sorts samples and handles odd and even counts", () => {
	assert.equal(median([82.65, 63.89, 56.34]), 63.89);
	assert.equal(median([2, 1, 4, 3]), 2.5);
	assert.equal(median([]), null);
});
