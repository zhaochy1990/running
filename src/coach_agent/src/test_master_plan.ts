import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMasterPlanGraph, MasterPlanGraphRequest, AthleteAssessmentSchema, GoalAssessmentSchema, ModelContractError, type AssessmentFacts, type AthleteAssessment, type ContextSnapshot, type GoalAssessment } from "./graph/master_plan/index.js";
import { MySqlMasterPlanContextProvider, StrideDataStore } from "./persistence/index.js";
import { buildResponsesModel } from "./agents/common.js";

type Profile = "local" | "prod";
const PROFILE = "local" as Profile;
const USER_ID = "11c2e582-5a85-4633-81d2-df7e37ad7b48";
const AS_OF = new Date().toISOString();

if (PROFILE === "prod") {
  const path = resolve(process.cwd(), "../../config/coach.prod.yaml");
  if (!existsSync(path)) throw new Error("prod profile is unavailable: config/coach.prod.yaml does not exist");
  process.env.STRIDE_COACH_ENV = "prod";
}

const { getAgentConfig, loadConfig, readStrideMySqlConfig } = await import("./config/config.js");
const config = loadConfig();
const modelConfig = getAgentConfig(config, "master_plan");
const store = StrideDataStore.create(readStrideMySqlConfig(config));
try {
  const provider = new MySqlMasterPlanContextProvider(store);
  let capturedSnapshot: ContextSnapshot | undefined;
  let capturedFacts: AssessmentFacts | undefined;
  let capturedAthleteAssessment: AthleteAssessment | undefined;
  let capturedGoalAssessment: GoalAssessment | undefined;
  const request = MasterPlanGraphRequest.parse({ request_id: `snapshot-${Date.now()}`, requested_mode: "new_season", requested_modifiers: [], goals: [{ race_name: "西安马拉松", location: "西安", distance: "FM", race_date: "2026-10-18", target_time: "2:50:00", finish_only: false, priority: "A" }], availability: { weekly_run_days_max: 6, available_training_windows: [], unavailable_days: ["sunday"], max_session_duration_min: 180, allows_double_sessions: false, preferred_long_run_day: "saturday", strength_sessions_per_week: 2, strength_available_days: ["monday", "thursday"] }, injury_declarations: [], environment_constraints: [], travel_constraints: [], preferences: [], prohibited_arrangements: [], active_plan_action: "none", user_confirmations: { intake_complete: true, goals_confirmed: true, availability_confirmed: true, injury_history_confirmed: true, constraints_confirmed: true }, requested_as_of: AS_OF });
  const graph = createMasterPlanGraph({
    contextProvider: { async loadSnapshot(userId, asOf) { capturedSnapshot = await provider.loadSnapshot(userId, asOf); return capturedSnapshot; } },
    assessmentModel: {
      async invoke(input) {
        capturedFacts = input.facts;
        try {
          const structured = buildResponsesModel(modelConfig).withStructuredOutput(AthleteAssessmentSchema, { name: "submit_athlete_assessment", method: "functionCalling", strict: true });
          capturedAthleteAssessment = await structured.invoke([
            ["system", "You are the athlete-readiness assessor. Submit only the forced function schema. Treat AssessmentFacts as immutable truth. Each material_conclusion uses claim + explanation + fact_ids. Allowed claims: volume_baseline_established, long_run_tolerance_established, quality_tolerance_established, availability_requires_adjustment, load_state_supportive, coverage_sufficient, goal_requires_improvement, goal_runway_limited, goal_supported_by_history. Each gap uses description + fact_ids. Do not put numerical values in explanation; cite fact_ids instead. Assess safe feasible ranges and gaps; do not prescribe a season strategy."],
            ["user", JSON.stringify({ task: "Assess athlete readiness for the confirmed request", request: input.request, assessment_facts: input.facts, snapshot: input.snapshot })],
          ]);
        } catch (error) {
          console.error(`athlete assessment call failed: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`);
          if (error instanceof Error && (error.name === "ZodError" || /structured|schema|parse/i.test(error.message))) throw new ModelContractError(error.message);
          throw error;
        }
        return capturedAthleteAssessment;
      },
    },
    goalAssessmentModel: {
      async invoke(input) {
        capturedFacts = input.facts;
        const structured = buildResponsesModel(modelConfig).withStructuredOutput(GoalAssessmentSchema, { name: "submit_goal_assessment", method: "functionCalling", strict: true });
        try {
          capturedGoalAssessment = await structured.invoke([
            ["system", "You are the race-goal feasibility assessor. Submit only the forced function schema. Treat AssessmentFacts as immutable truth. Each material_conclusion uses an allowed claim + explanation + fact_ids; every conflict uses description + fact_ids. A.target is {kind:'time',time_seconds:confirmed target seconds,label:confirmed time}; B.target is a strictly slower time or PB; C.target is a still slower time, PB, or finish fallback. Every gate condition cites fact_ids. Do not prescribe training. Use multi_cycle_required only for the deterministic extreme-gap case; otherwise multi_cycle_path must be empty."],
            ["user", JSON.stringify({ task: "Assess the confirmed race goal", request: input.request, assessment_facts: input.facts, snapshot: input.snapshot })],
          ]);
        } catch (error) {
          if (error instanceof Error && (error.name === "ZodError" || /structured|schema|parse/i.test(error.message))) throw new ModelContractError(error.message);
          throw error;
        }
        return capturedGoalAssessment;
      },
    },
    skeletonModel: { async invoke({ request: r }) { const goal = r.goals.find((g) => g.priority === "A")!; return { status: "draft", goal: { race_name: goal.race_name, distance: goal.distance, race_date: goal.race_date, target_time: goal.target_time!, timezone: "Asia/Shanghai", location: goal.location }, start_date: "2026-10-12", end_date: goal.race_date, total_weeks: 1, phases: [{ name: "赛前减量期", start_date: "2026-10-12", end_date: goal.race_date, focus: "Issue #343 runner seam", weekly_distance_km_low: 42.195, weekly_distance_km_high: 42.195, key_session_types: ["race"], milestones: [{ type: "race", date: goal.race_date, target: goal.race_name, completed_actual: null }], key_workouts: "Goal race", monitoring_triggers: ["stub only"], coach_note: "inactive stub", strength: { sessions_per_week: 0, focus: "none", timing: "none" }, recovery: { focus: "recovery", sleep_target_hours: "7-9", adjustment_trigger: "pain" }, is_completed: false, summary: null }], weeks: [{ week_index: 1, week_start: "2026-10-12", phase_name: "赛前减量期", target_weekly_km_low: 42.195, target_weekly_km_high: 42.195, key_sessions: [{ type: "race", distance_km: 42.195, duration_min: 170, intensity: "goal race", purpose: "stub" }], is_recovery_week: false }], training_principles: ["Evaluation-only inactive stub"], generated_by: "coach_agent", version: 1, created_at: AS_OF, updated_at: AS_OF }; } },
  });
  const generationId = `master-plan-${PROFILE}-${Date.now()}`;
  const result = await graph.invoke({ request }, { context: { userId: USER_ID, generationId } });
  if (result.outcome?.decision === "infrastructure_failure") {
    throw new Error(`planning snapshot failed: ${result.outcome.code}`);
  }
  if (!capturedSnapshot) throw new Error("snapshot was not loaded");
  const outputDir = resolve(process.cwd(), "../../.omc/eval/master-plan", generationId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "snapshot-manifest.json"), `${JSON.stringify(redactedManifest(capturedSnapshot), null, 2)}\n`, "utf8");
  if (capturedFacts) await writeFile(resolve(outputDir, "assessment-facts.json"), `${JSON.stringify(capturedFacts, null, 2)}\n`, "utf8");
  if (capturedAthleteAssessment) await writeFile(resolve(outputDir, "athlete-assessment.json"), `${JSON.stringify(capturedAthleteAssessment, null, 2)}\n`, "utf8");
  if (capturedGoalAssessment) await writeFile(resolve(outputDir, "goal-assessment.json"), `${JSON.stringify(capturedGoalAssessment, null, 2)}\n`, "utf8");
  await writeFile(resolve(outputDir, "outcome.json"), `${JSON.stringify(result.outcome, null, 2)}\n`, "utf8");
  console.log(`Master-plan evaluation artifacts: ${outputDir}; model=${modelConfig.model}`);
} finally { await store.close(); }

function redactedManifest(snapshot: ContextSnapshot) { return { schema_version: snapshot.schema_version, as_of: snapshot.as_of, user: { id: "[redacted]" }, coverage: snapshot.coverage, source_manifest: snapshot.source_manifest, aggregate_counts: { months: snapshot.macro_history.months.length, recent_weeks: snapshot.recent_history.weeks.length, races: snapshot.race_history.length, personal_bests: snapshot.personal_bests.length, injuries: snapshot.injuries.length }, body_composition_fields_available: { weight_kg: snapshot.body_composition.weight_kg !== null, body_fat_pct: snapshot.body_composition.body_fat_pct !== null, skeletal_muscle_kg: snapshot.body_composition.skeletal_muscle_kg !== null } }; }
