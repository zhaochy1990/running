import assert from "node:assert/strict";
import test from "node:test";
import {
	isQualityRunningActivity,
	isRunningActivity,
} from "./activityClassification.js";

test("running classification accepts canonical sport fields", () => {
	assert.equal(
		isRunningActivity({
			name: null,
			sport: "run_outdoor",
			sportName: null,
			sportNote: null,
			trainKind: null,
		}),
		true,
	);
	assert.equal(
		isRunningActivity({
			name: null,
			sport: null,
			sportName: "Outdoor Run",
			sportNote: null,
			trainKind: null,
		}),
		true,
	);
});

test("quality classification uses training kind and descriptive name", () => {
	assert.equal(
		isQualityRunningActivity({
			name: "Easy run",
			sport: "run_outdoor",
			sportName: "Outdoor Run",
			sportNote: null,
			trainKind: "speed",
		}),
		true,
	);
	assert.equal(
		isQualityRunningActivity({
			name: "3 x 10 min tempo",
			sport: "run_outdoor",
			sportName: "Outdoor Run",
			sportNote: null,
			trainKind: "base",
		}),
		true,
	);
	assert.equal(
		isQualityRunningActivity({
			name: "Tempo ride",
			sport: "bike",
			sportName: "Cycling",
			sportNote: null,
			trainKind: "tempo",
		}),
		false,
	);
	assert.equal(
		isQualityRunningActivity({
			name: "Long run",
			sport: "run_outdoor",
			sportName: "Outdoor Run",
			sportNote: "后段 8 km 马配",
			trainKind: "aerobic",
		}),
		true,
	);
});
