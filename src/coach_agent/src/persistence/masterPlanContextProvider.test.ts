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
