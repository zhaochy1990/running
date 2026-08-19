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
			strideSessionClass: null,
		}),
		true,
	);
	assert.equal(
		isRunningActivity({
			name: null,
			sport: null,
			sportName: "Outdoor Run",
			sportNote: null,
			strideSessionClass: null,
		}),
		true,
	);
});

test("quality classification uses STRIDE session class and descriptive name", () => {
	assert.equal(
		isQualityRunningActivity({
			name: "Short repetitions",
			sport: "run_outdoor",
			sportName: "Outdoor Run",
			sportNote: null,
			strideSessionClass: "sprint",
		}),
		true,
	);
	assert.equal(
		isQualityRunningActivity({
			name: "Hill repeats",
			sport: "run_outdoor",
			sportName: "Outdoor Run",
			sportNote: null,
			strideSessionClass: "aerobic",
		}),
		true,
	);
	assert.equal(
		isQualityRunningActivity({
			name: "上海马拉松",
			sport: "run_outdoor",
			sportName: "Outdoor Run",
			sportNote: null,
			strideSessionClass: "base",
		}),
		true,
	);
	assert.equal(
		isQualityRunningActivity({
			name: "Easy hilly run",
			sport: "run_outdoor",
			sportName: "Outdoor Run",
			sportNote: null,
			strideSessionClass: "base",
		}),
		false,
	);
	assert.equal(
		isQualityRunningActivity({
			name: "City marathon",
			sport: "run_outdoor",
			sportName: "Outdoor Run",
			sportNote: null,
			strideSessionClass: "race",
		}),
		true,
	);
	assert.equal(
		isQualityRunningActivity({
			name: "Easy run",
			sport: "run_outdoor",
			sportName: "Outdoor Run",
			sportNote: null,
			strideSessionClass: "speed",
		}),
		true,
	);
	assert.equal(
		isQualityRunningActivity({
			name: "3 x 10 min tempo",
			sport: "run_outdoor",
			sportName: "Outdoor Run",
			sportNote: null,
			strideSessionClass: "base",
		}),
		true,
	);
	assert.equal(
		isQualityRunningActivity({
			name: "Tempo ride",
			sport: "bike",
			sportName: "Cycling",
			sportNote: null,
			strideSessionClass: "tempo",
		}),
		false,
	);
	assert.equal(
		isQualityRunningActivity({
			name: "Long run",
			sport: "run_outdoor",
			sportName: "Outdoor Run",
			sportNote: "后段 8 km 马配",
			strideSessionClass: "aerobic",
		}),
		true,
	);
});
