import {
  createMasterPlanGraph,
  createMasterPlanLlmModels,
  DataProviderMasterPlanContextProvider,
  getAgentConfig,
  loadConfig,
  MasterPlanGraphRequest,
} from "@stride/coach-agent";
import { loadApiConfig } from "../src/config.js";
import { coachAgentConfigFiles, coachApiConfigFiles } from "../src/configPaths.js";
import { MySqlDataProvider } from "@stride/coach-agent-worker";

type Profile = "local" | "prod";
const PROFILE = "prod" as Profile;
// configPaths resolves the overlay from STRIDE_COACH_ENV, so wire PROFILE into it
// before any config is loaded below.
process.env.STRIDE_COACH_ENV = PROFILE;
const USER_ID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const AS_OF = new Date().toISOString();

export const config = loadConfig({ configFiles: coachAgentConfigFiles(import.meta.url) });
const modelConfig = getAgentConfig(config, "master_plan");
const phasingConfig = getAgentConfig(config, "phasing");
const contentConfig = getAgentConfig(config, "master_plan");

const configFiles = coachApiConfigFiles(import.meta.url);
const store = MySqlDataProvider.create(loadApiConfig({ configFiles }).strideDatabase);

const provider = new DataProviderMasterPlanContextProvider(store);

const request = MasterPlanGraphRequest.parse({
  request_id: `snapshot-${Date.now()}`,
  requested_mode: "new_season",
  requested_modifiers: [],
  goals: [
    {
      race_name: "上海马拉松",
      distance: "FM",
      race_date: process.env.MP_RACE_DATE ?? "2027-03-21",
      target_time: process.env.MP_TARGET_TIME ?? "2:57:00",
      finish_only: false,
      priority: "A",
    },
  ],
  availability: {
    weekly_run_days_max: 6,
    available_training_windows: [],
    unavailable_days: [],
    max_session_duration_min: 180,
    allows_double_sessions: true,
    preferred_long_run_day: "sunday",
    strength_sessions_per_week: 2,
    strength_available_days: ["monday", "thursday"],
  },
  injury_declarations: [],
  environment_constraints: [],
  travel_constraints: [],
  preferences: [],
  prohibited_arrangements: [],
  active_plan_action: "none",
  user_confirmations: {
    intake_complete: true,
    goals_confirmed: true,
    availability_confirmed: true,
    injury_history_confirmed: true,
    constraints_confirmed: true,
  },
  requested_as_of: AS_OF,
});

async function main() {
  try {
    const llmModels = createMasterPlanLlmModels({
      masterPlanModel: modelConfig,
      phasingModel: phasingConfig,
      contentModel: contentConfig,
    });
    const graph = createMasterPlanGraph({ contextProvider: provider, ...llmModels });
    const generationId = `master-plan-${PROFILE}-${Date.now()}`;
    const startedAt = Date.now();
    const result = await graph.invoke({ request }, { context: { userId: USER_ID, generationId } });
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    const outcome = result.outcome;
    console.log(`decision=${outcome.decision} elapsed=${elapsed}s`);
    if (outcome.decision === "completed") {
      const artifact = outcome.artifact;
      console.log(`artifact_revision=${artifact.artifact_revision} weeks=${artifact.plan.total_weeks}`);
      console.log(
        `phases=${artifact.policy.phases
          .map((phase) => `${phase.canonical}W${phase.start_week}-${phase.end_week}`)
          .join(" ")}`,
      );
      console.log(`skeleton_km=${artifact.skeleton.weeks.map((week) => week.km).join("/")}`);
      console.log(`load_gates=${artifact.skeleton.checks.filter((check) => check.pass).length}/${artifact.skeleton.checks.length}`);
      const { pass, warn, fail } = artifact.audit.summary;
      console.log(`audit=✅${pass} ⚠️${warn} ❌${fail}`);
      for (const item of artifact.audit.items.filter((entry) => entry.verdict !== "pass"))
        console.log(`  ${item.verdict}: ${item.item} — ${item.actual}`);
      console.log(`warnings=${artifact.warnings.join(",") || "none"}`);
      // 全量产物导出（MP_DUMP=path）：课表细节+政策包+审计，供验收报告渲染
      if (process.env.MP_DUMP) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(process.env.MP_DUMP, JSON.stringify(artifact, null, 1));
        console.log(`dumped -> ${process.env.MP_DUMP}`);
      }
      // 内容层若走了模板兜底，把重试违规打出来——这是「计划能出来但不是模型写的」的唯一现场。
      if (artifact.warnings.includes("content_template_fallback"))
        console.log("L4 走了模板兜底：查 content 节点的 retry violations 日志（level:40）定位违规簇");
    } else {
      console.log(JSON.stringify(outcome, null, 2).slice(0, 2000));
    }
  } finally {
    await store.close();
  }
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
