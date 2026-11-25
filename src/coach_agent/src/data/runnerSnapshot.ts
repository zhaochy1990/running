import { AVAILABILITY_WEEKDAY } from "@stride/contract";
import { z } from "zod/v4";
import { CalibrationSelectionSchema, CalibrationSourceSchema } from "./calibrationMetadata.js";

/**
 * RunnerSnapshot —— 训练计划测评平台的脱敏跑者快照（devops#1055/#1058）。
 *
 * 数据级冻结：保存 DataProvider 读面的 JSON 投影（逐条活动、比赛成绩、校准、
 * 恢复、历史覆盖），而不是装配好的 ContextSnapshot——这样被测版本自己的
 * `DataProviderMasterPlanContextProvider` 照常跑取数与聚合，上下文装配层的变化
 * 也能被测评到。域类型里的 `Date` 在快照里一律存 ISO 瞬时字符串。
 */

/** 上海日历日：真实日历日期（2026-13-40、2026-02-30 都不合法）。 */
const day = z.iso.date();
const RACE_TIME = /^\d{1,2}:[0-5]\d:[0-5]\d$/;
const INSTANT = z.string().datetime({ offset: true });
const num = z.number().nullable();
const str = z.string().nullable();

const ActivityLapJsonSchema = z
  .object({
    lapIndex: z.number().int().nonnegative(),
    lapType: str,
    distanceM: num,
    durationS: num,
    avgPace: num,
    adjustedPace: num,
    avgHr: num,
    maxHr: num,
    avgCadence: num,
    avgPower: num,
    ascentM: num,
    descentM: num,
    exerciseType: num,
    exerciseNameKey: str,
    mode: num,
  })
  .strict();

const ActivityJsonSchema = z
  .object({
    userId: z.string(),
    labelId: z.string(),
    name: str,
    sportName: str,
    date: INSTANT,
    shanghaiDay: day,
    distanceM: num,
    durationS: num,
    avgPaceSKm: num,
    bestKmPace: num,
    maxPace: num,
    avgHr: num,
    maxHr: num,
    avgCadence: num,
    maxCadence: num,
    avgPower: num,
    maxPower: num,
    avgStepLenCm: num,
    ascentM: num,
    descentM: num,
    strideDose: num,
    strideSessionClass: str,
    temperature: num,
    humidity: num,
    feelsLike: num,
    windSpeed: num,
    sportNote: str,
    sport: str,
    feel: num,
    feelNote: str,
    verticalOscillationMm: num,
    groundContactTimeMs: num,
    verticalRatioPct: num,
    pauses: z.json().nullable(),
    provider: z.string(),
    laps: z.array(ActivityLapJsonSchema),
  })
  .strict();

const SyncStageGapJsonSchema = z.object({ from: day, to: day, reason: z.string().optional() }).strict();
const SyncStageCoverageJsonSchema = z
  .object({
    stage: z.string(),
    status: z.string(),
    readiness: z.string(),
    targetFrom: day,
    targetTo: day,
    scannedFrom: str,
    scannedTo: str,
    observedFrom: str,
    observedTo: str,
    gaps: z.array(SyncStageGapJsonSchema),
    error: str,
  })
  .strict();
const SyncCoverageJsonSchema = z
  .object({
    sessionId: z.string(),
    state: z.string(),
    provider: z.string(),
    bindingRevision: z.number().int(),
    anchorDay: day,
    error: str,
    stages: z.array(SyncStageCoverageJsonSchema),
    readiness: z
      .object({
        shellReady: z.boolean(),
        recentData: z.string(),
        recentAnalysis: z.string(),
        extendedData: z.string(),
        historicalData: z.string(),
        historicalAnalysis: z.string(),
        auxiliary: z.string(),
      })
      .strict(),
    recentAnalysisDetail: z
      .object({
        asOfDay: day,
        status: z.string(),
        stale: z.boolean(),
        refreshing: z.boolean(),
        domains: z.record(z.string(), z.object({ status: z.string(), reason: z.string().optional() }).strict()),
        coverageFrom: str,
        coverageTo: str,
        inputFingerprint: z.string(),
        computedAt: INSTANT,
      })
      .strict()
      .nullable(),
    updatedAt: INSTANT,
  })
  .strict();

/** 冻结记录：DataProvider 各读方法的返回值原样投影（字段名 = TS 域类型）。 */
const RecordsJsonSchema = z
  .object({
    profile: z
      .object({
        userId: z.string(),
        displayName: str,
        dob: str,
        sex: str,
        heightCm: num,
        weightKg: num,
        runningAgeRange: str,
      })
      .strict()
      .nullable(),
    injuries: z
      .array(z.object({ description: z.string(), recoveryStatus: z.string(), runningRestriction: z.string() }).strict()),
    race_target: z
      .object({
        goal_id: z.string(),
        user_id: z.string(),
        status: z.string(),
        race_date: day,
        race_distance: z.string(),
        race_name: z.string(),
        target_finish_time: z.string(),
        weekly_training_days: z.number().int(),
      })
      .strict()
      .nullable(),
    personal_bests: z.array(
      z
        .object({
          distance: z.string(),
          timeSec: z.number(),
          achievedAt: str,
          activityLabelId: z.string().min(1),
        })
        .strict(),
    ),
    running_calibration: z
      .object({
        calibrationId: z.number().optional(),
        algorithmVersion: z.number().optional(),
        computedAt: z.string().optional(),
        selection: CalibrationSelectionSchema.optional(),
        source: CalibrationSourceSchema.optional(),
        fingerprint: z.string().optional(),
        asOfDate: day,
        thresholdHr: num,
        thresholdSpeedMps: num,
        rhrBaseline: num,
        thresholdHrConfidence: z.string(),
        thresholdSpeedConfidence: z.string(),
        heartRateZones: z.array(z.object({ name: z.string(), minBpm: num, maxBpm: num }).strict()),
        paceZones: z.array(z.object({ name: z.string(), minPaceSPerKm: num, maxPaceSPerKm: num }).strict()),
      })
      .strict()
      .nullable(),
    race_history: z.array(
      z
        .object({
          date: day,
          labelId: z.string(),
          name: str,
          sport: str,
          distanceKm: num,
          durationMin: num,
          avgPaceSKm: num,
          avgHr: num,
          maxHr: num,
          feel: num,
          source: z.object({ races: z.boolean(), sessionClass: z.boolean() }).strict(),
        })
        .strict(),
    ),
    activities: z.array(ActivityJsonSchema),
    daily_training_load: z.array(
      z
        .object({
          date: day,
          trainingDose: z.number(),
          acuteLoad: num,
          chronicLoad: num,
          form: num,
          loadRatio: num,
          coverageStatus: z.string(),
        })
        .strict(),
    ),
    daily_recovery: z.array(z.object({ date: day, rhr: num, hrv: num }).strict()),
    active_master_plan: z
      .object({
        planId: z.string(),
        revision: z.number(),
        status: z.string(),
        content: z.record(z.string(), z.unknown()),
      })
      .strict()
      .nullable(),
    sync_coverage: SyncCoverageJsonSchema.nullable(),
  })
  .strict();

export const RUNNER_SNAPSHOT_SCHEMA_ID = "plan-eval-runner-snapshot/v1";

export const RunnerSnapshotSchema = z
  .object({
    schema: z.literal(RUNNER_SNAPSHOT_SCHEMA_ID),
    /** 平台生成的随机 UUID；编辑沿用。 */
    snapshot_id: z.string().min(1),
    /** 脱敏引用（首批样本 = sha256(user_id) 前 12 位）。 */
    username: z.string().min(1),
    /** 生成类型：新建赛季 / 到期接续 / 漏排追赶。 */
    generation_kind: z.enum(["new_season", "rolling_continue", "rolling_catch_up"]),
    /** 项目与目标成绩只用于展示；权威值在场景冻结的生成请求里。 */
    event: z.enum(["FM", "HM"]),
    target_time: z.string().regex(RACE_TIME).nullable(),
    /** 上海数据截止日（含当日）：快照只含这一天结束时已知的记录。 */
    as_of_day: day,
    /** 规则直接读取的训练约束（每周跑步日上限与禁跑日）。 */
    constraints: z
      .object({
        max_run_days_per_week: z.number().int().min(1).max(7),
        no_run_days: z.array(AVAILABILITY_WEEKDAY),
      })
      .strict(),
    records: RecordsJsonSchema,
    provenance: z
      .object({
        source: z.string().min(1),
        exported_at: INSTANT,
      })
      .strict(),
  })
  .strict();

/** JSON 线上形状（Date 已是字符串）。 */
export type RunnerSnapshot = z.infer<typeof RunnerSnapshotSchema>;
export type RunnerSnapshotRecords = RunnerSnapshot["records"];
