#!/usr/bin/env node
// 导出一份测评用 RunnerSnapshot（devops#1055）：用生产同款 MySqlDataProvider 读面，
// 按上海数据截止日冻结一名跑者的数据级记录并脱敏。
//
//   node scripts/export-runner-snapshot.mjs --user <uuid> --as-of 2026-10-23 \
//     --event FM --target-time 3:10:00 --max-run-days 5 --out <snapshot.json> \
//     [--snapshot-id <uuid>]   # 固定主键（预置样本要稳定 ID 时用；缺省随机）
//
// 连接经环境变量：STRIDE_EXPORT_DB_HOST / _PORT / _USER / _PASSWORD / _DATABASE。
// 先 `pnpm --filter @stride/coach-agent-worker... build`（脚本读 dist/）。
//
// 脱敏：user_id → sha256 前 12 位作引用、另派生一个确定性 UUID；显示名换成该引用。
// 其余（出生日期、身高体重、活动）是能力证据，原样保留。
//
// 已知边界：race_goal / master_plan 是“当前态”读面，拿到的是导出时刻的状态——
// 调用方须确认它们的创建时间不晚于截止日，否则快照会带上当时并不存在的计划/目标。
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { RUNNER_SNAPSHOT_SCHEMA_ID, RunnerSnapshotSchema } from "@stride/coach-agent";
import { planningStartDate } from "@stride/contract";
import mysql from "mysql2/promise";
import { MySqlDataProvider } from "../dist/src/data/mysqlDataProvider.js";

const {
  values: { user, "as-of": asOfDay, event, "target-time": targetTime, "max-run-days": maxRunDays, out, username, "snapshot-id": snapshotId },
} = parseArgs({
  options: {
    user: { type: "string" },
    "as-of": { type: "string" },
    event: { type: "string" },
    "target-time": { type: "string" },
    "max-run-days": { type: "string" },
    username: { type: "string" },
    "snapshot-id": { type: "string" },
    out: { type: "string" },
  },
});
if (!user || !asOfDay || !event || !maxRunDays || !out) {
  throw new Error("usage: --user <uuid> --as-of <YYYY-MM-DD> --event FM|HM --max-run-days <1-7> [--target-time H:MM:SS] --out <file>");
}

const env = process.env;
const pool = mysql.createPool({
  host: env.STRIDE_EXPORT_DB_HOST,
  port: Number(env.STRIDE_EXPORT_DB_PORT ?? 3306),
  user: env.STRIDE_EXPORT_DB_USER,
  password: env.STRIDE_EXPORT_DB_PASSWORD,
  database: env.STRIDE_EXPORT_DB_DATABASE,
  timezone: "Z", // 与 createStridePool 同口径：DATETIME 按 UTC 读
});
const provider = new MySqlDataProvider(pool);

// 截止日之前的全部历史：被测版本要哪个窗口由它自己的上下文装配决定，快照不预裁。
const ALL_HISTORY = "1900-01-01";
const [profile, injuries, activities, loads, recovery, pbs, calibration, races, activePlan, raceTarget, syncCoverage] = await Promise.all([
  provider.getUserProfile(user),
  provider.getUserInjuries(user),
  provider.getActivitiesByDateRange(user, ALL_HISTORY, asOfDay),
  provider.getDailyTrainingLoadByDateRange(user, ALL_HISTORY, asOfDay),
  provider.getDailyRecoveryByDateRange(user, ALL_HISTORY, asOfDay),
  provider.getPersonalBests(user, asOfDay),
  provider.getLatestRunningCalibration(user, asOfDay),
  provider.getRaceHistory(user, { asOfDate: asOfDay, minDistanceKm: 0, limit: 100 }),
  provider.getMasterPlanMetadataForDate(user, planningStartDate(asOfDay)),
  provider.getRaceTarget(user),
  provider.getSyncCoverage(user),
]);
await pool.end();

const digest = createHash("sha256").update(user).digest("hex");
const ref = username ?? digest.slice(0, 12);
const hex = digest.slice(0, 32);
const evalUserId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;

// 域类型里的 Date 经 JSON 往返落成 ISO 瞬时字符串 = 快照的线上形状。
const records = JSON.parse(
  JSON.stringify({
    profile: profile ? { ...profile, userId: evalUserId, displayName: ref } : null,
    injuries,
    race_target: raceTarget ? { ...raceTarget, user_id: evalUserId } : null,
    personal_bests: pbs,
    running_calibration: calibration,
    race_history: races,
    activities: activities.map((activity) => ({ ...activity, userId: evalUserId })),
    daily_training_load: loads,
    daily_recovery: recovery,
    active_master_plan: activePlan,
    sync_coverage: syncCoverage,
  }),
);

const snapshot = RunnerSnapshotSchema.parse({
  schema: RUNNER_SNAPSHOT_SCHEMA_ID,
  snapshot_id: snapshotId ?? crypto.randomUUID(),
  username: ref,
  generation_kind: "new_season",
  event,
  target_time: targetTime ?? null,
  as_of_day: asOfDay,
  constraints: { max_run_days_per_week: Number(maxRunDays), no_run_days: [] },
  records,
  provenance: { source: "stride MySQL (production mirror), MySqlDataProvider read surface", exported_at: new Date().toISOString() },
});
await writeFile(out, `${JSON.stringify(snapshot)}\n`); // 最小化：快照是机器数据，内嵌进二进制前不再二次加工
console.log(
  JSON.stringify(
    {
      out,
      snapshot_id: snapshot.snapshot_id,
      username: snapshot.username,
      activities: activities.length,
      runs: activities.filter((activity) => activity.sport?.toLowerCase().startsWith("run")).length,
      laps: activities.reduce((sum, activity) => sum + activity.laps.length, 0),
      loads: loads.length,
      recovery: recovery.length,
      personal_bests: pbs.length,
      races: races.length,
      calibration_as_of: calibration?.asOfDate ?? null,
      // 当前态读面：请核对这两项的创建时间不晚于截止日。
      active_master_plan: activePlan ? { plan_id: activePlan.planId, status: activePlan.status } : null,
      race_target: raceTarget ? { race_date: raceTarget.race_date, race_distance: raceTarget.race_distance } : null,
    },
    null,
    2,
  ),
);
