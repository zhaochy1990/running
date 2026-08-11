import assert from "node:assert/strict";
import test from "node:test";
import { MySqlMasterPlanContextProvider } from "./masterPlanContextProvider.js";

test("context provider maps canonical injuries and numeric race feel", async () => {
  const provider = new MySqlMasterPlanContextProvider({
    async getUserProfile() { return { userId: "athlete", displayName: null, dob: null, sex: null, heightCm: null, weightKg: 70, runningAgeRange: "5_10" }; },
    async getUserInjuries() { return [{ description: "right Achilles", recoveryStatus: "active", runningRestriction: "easy_only" }]; },
    async getActivitiesByDateRange() { return []; },
    async getDailyTrainingLoadByDateRange() { return []; },
    async getDailyRecoveryByDateRange() { return []; },
    async getPersonalBests() { return []; },
    async getLatestRunningCalibration() { return null; },
    async getRaceHistory() { return [{ date: "2026-07-01", labelId: "race", name: null, sport: "run_outdoor", distanceKm: 42.2, durationMin: 180, avgPaceSKm: 256, avgHr: 165, maxHr: 180, feel: 8 }]; },
    async getActiveMasterPlanMetadata() { return null; },
  });

  const snapshot = await provider.loadSnapshot("athlete", "2026-08-11T00:00:00Z");

  assert.deepEqual(snapshot.injuries, [{ body_area: "right Achilles", status: "active; restriction=easy_only", occurred_on: null, source: "mysql.user_injury" }]);
  assert.equal(snapshot.race_history[0]?.feel, 8);
  assert.deepEqual(snapshot.source_manifest.find((item) => item.domain === "injuries"), { domain: "injuries", source: "mysql.user_injury", range_start: null, range_end: "2026-08-11", records: 1 });
});

test("context provider excludes trail-labelled outdoor activities from road-run evidence", async () => {
  const trail = { userId: "athlete", labelId: "trail", name: "山地越野", sportName: "Outdoor Run", date: new Date("2026-07-01T00:00:00Z"), distanceM: 50000, durationS: 20000, avgPaceSKm: null, adjustedPace: null, bestKmPace: null, maxPace: null, avgHr: null, maxHr: null, avgCadence: null, maxCadence: null, avgPower: null, maxPower: null, avgStepLenCm: null, ascentM: null, descentM: null, caloriesKcal: null, aerobicEffect: null, anaerobicEffect: null, trainingLoad: null, strideDose: null, vo2max: null, temperature: null, humidity: null, feelsLike: null, windSpeed: null, sportNote: null, sport: "run_outdoor", trainKind: null, feel: null, verticalOscillationMm: null, groundContactTimeMs: null, verticalRatioPct: null, pauses: null, provider: "coros" };
  const road = { ...trail, labelId: "road", name: "公路长跑", distanceM: 30000 };
  const provider = new MySqlMasterPlanContextProvider({
    async getUserProfile() { return { userId: "athlete", displayName: null, dob: null, sex: null, heightCm: null, weightKg: 70, runningAgeRange: "5_10" }; }, async getUserInjuries() { return []; }, async getActivitiesByDateRange() { return [trail, road]; }, async getDailyTrainingLoadByDateRange() { return []; }, async getDailyRecoveryByDateRange() { return []; }, async getPersonalBests() { return []; }, async getLatestRunningCalibration() { return null; }, async getRaceHistory() { return []; }, async getActiveMasterPlanMetadata() { return null; },
  });
  const snapshot = await provider.loadSnapshot("athlete", "2026-08-11T00:00:00Z");
  assert.equal(snapshot.macro_history.longest_run_km, 50);
  assert.equal(snapshot.macro_history.longest_road_run_km, 30);
});

test("context provider materializes complete zero-run weeks", async () => {
  const provider = new MySqlMasterPlanContextProvider({
    async getUserProfile() { return { userId: "athlete", displayName: null, dob: null, sex: null, heightCm: null, weightKg: 70, runningAgeRange: "5_10" }; }, async getUserInjuries() { return []; }, async getActivitiesByDateRange() { return []; }, async getDailyTrainingLoadByDateRange() { return []; }, async getDailyRecoveryByDateRange() { return []; }, async getPersonalBests() { return []; }, async getLatestRunningCalibration() { return null; }, async getRaceHistory() { return []; }, async getActiveMasterPlanMetadata() { return null; },
  });
  const snapshot = await provider.loadSnapshot("athlete", "2026-08-11T00:00:00Z");
  assert.equal(snapshot.recent_history.weeks.length, 17);
  assert.equal(snapshot.recent_history.weeks.at(-2)?.run_day_count, 0);
  assert.equal(snapshot.recent_history.weeks.at(-2)?.distance_km, 0);
});
