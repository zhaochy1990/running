/** MySQL adapter for the Coach Agent read-only DataProvider seam. */
import type {
  AbilityL4Baseline,
  ActiveMasterPlanMetadata,
  Activity,
  ActivityLap,
  DailyRecovery,
  DailyTrainingLoad,
  DataProvider,
  DaySessionRow,
  HeartRateZone,
  ManualStrengthRecord,
  MasterPlanDocument,
  PaceZone,
  PerformanceBaseline,
  PersonalBest,
  RaceAidStation,
  RaceCalendarContext,
  RaceCalendarItemContent,
  RaceCalendarSearchQuery,
  RaceCalendarSummary,
  RaceCourseChallenge,
  RaceCutoff,
  RaceEffort,
  RaceElevationPoint,
  RacePredictionRow,
  RaceTarget,
  RunningCalibration,
  StrengthRecordSummary,
  SyncCoverage,
  SyncDispatchRow,
  SyncReadiness,
  SyncRecentAnalysisRow,
  SyncSessionRow,
  SyncStageCoverageRow,
  UserInjury,
  UserProfile,
  VendorHrvBaseline,
  WeeklyFeedback,
  WeeklyPlanDocument,
} from "@stride/coach-agent";
import { CalibrationSourceSchema, deriveSyncCoverage } from "@stride/coach-agent";
import { getLogger } from "@stride/common";
import { addDays, shanghaiDay } from "@stride/contract";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import type { MySqlConfig } from "../config.js";
import { createStridePool } from "../db/mysql.js";
import { GoJobClient } from "../goClient/jobClient.js";
import policyContract from "./calibrationPolicyContract.json" with { type: "json" };

const logger = getLogger("coach:activityDetails");
type GoActivityAPI = { baseUrl: string; internalToken: string };
// Mirrors Go's strength activity filter in storage/activity_read.go.
const WATCH_STRENGTH_PREDICATE = "(a.sport_type IN (402, 800) OR a.sport = 'strength' OR lower(coalesce(a.sport_name, '')) LIKE '%strength%')";
const manualStrengthActions = z.array(
  z.object({
    name: z.string(),
    sets: z.array(
      z.object({
        load: z.string(),
        load_unit: z.enum(["kg", "lb", "bodyweight"]),
        quantity: z.number().int().positive(),
        quantity_unit: z.enum(["reps", "seconds"]),
      }),
    ),
  }),
);
const goActivityDetails = z.object({
  kilometer_splits: z.array(z.record(z.string(), z.unknown())).optional(),
});
const raceReputationJson = z.object({
  summary: z.string().default(""),
  pros: z
    .array(z.string())
    .nullish()
    .transform((pros) => pros ?? []),
  cons: z
    .array(z.string())
    .nullish()
    .transform((cons) => cons ?? []),
});

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(day: string): string {
  if (!DAY_RE.test(day)) {
    throw new Error(`invalid day (expected YYYY-MM-DD Shanghai calendar day): ${day}`);
  }
  return day;
}
export class MySqlDataProvider implements DataProvider {
  private readonly ownsPool: boolean;
  private readonly goAPI: GoActivityAPI | undefined;

  /**
   * Wrap an existing pool (inject for tests / reuse), or use {@link MySqlDataProvider.create}
   * to open a self-owned pool against the local `stride` DB.
   */
  constructor(
    private readonly pool: Pool,
    options: { ownsPool?: boolean; goAPI?: GoActivityAPI } = {},
  ) {
    this.ownsPool = options.ownsPool ?? false;
    this.goAPI = options.goAPI;
  }

  /**
   * Open a connection pool to the local `stride` MySQL DB and return a store.
   * `config` comes from the API-owned `loadApiConfig().strideDatabase`.
   */
  static create(config: MySqlConfig, goAPI?: GoActivityAPI): MySqlDataProvider {
    return new MySqlDataProvider(createStridePool(config), { ownsPool: true, ...(goAPI && { goAPI }) });
  }

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT user_id, display_name, DATE_FORMAT(dob, '%Y-%m-%d') AS dob, sex, height_cm, weight_kg, running_age_range FROM user_profile WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    const row = rows[0];
    return row
      ? {
          userId: row.user_id as string,
          displayName: (row.display_name ?? null) as string | null,
          dob: (row.dob ?? null) as string | null,
          sex: (row.sex ?? null) as string | null,
          heightCm: (row.height_cm ?? null) as number | null,
          weightKg: (row.weight_kg ?? null) as number | null,
          runningAgeRange: (row.running_age_range ?? null) as string | null,
        }
      : null;
  }

  async getUserInjuries(userId: string): Promise<UserInjury[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT description, recovery_status, running_restriction
         FROM user_injury
        WHERE user_id = ?
        ORDER BY created_at ASC, id ASC`,
      [userId],
    );
    return rows.map((row) => ({
      description: row.description as string,
      recoveryStatus: row.recovery_status as string,
      runningRestriction: row.running_restriction as string,
    }));
  }

  async getVendorHrvBaseline(userId: string, asOfDay: string): Promise<VendorHrvBaseline | null> {
    assertDay(asOfDay);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT h.date, h.baseline_balanced_low, h.baseline_balanced_upper, h.provider
			   FROM daily_hrv h
			   JOIN dashboard d ON d.user_id = h.user_id AND d.provider = h.provider
			  WHERE h.user_id = ?
			    AND REPLACE(h.date, '-', '') <= REPLACE(?, '-', '')
			    AND h.baseline_balanced_low IS NOT NULL
			    AND h.baseline_balanced_upper IS NOT NULL
			  ORDER BY REPLACE(h.date, '-', '') DESC
			  LIMIT 1`,
      [userId, asOfDay],
    );
    const row = rows[0];
    return row
      ? {
          low: (row.baseline_balanced_low ?? null) as number | null,
          high: (row.baseline_balanced_upper ?? null) as number | null,
          provider: row.provider as string,
          date: normalizeDay(row.date as string),
        }
      : null;
  }

  async getDailyRecoveryByDateRange(userId: string, startDay: string, endDay: string): Promise<DailyRecovery[]> {
    assertDay(startDay);
    assertDay(endDay);
    if (startDay > endDay) {
      throw new Error(`startDay (${startDay}) must not be after endDay (${endDay})`);
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT h.date, h.rhr, MAX(v.last_night_avg) AS hrv FROM daily_health h LEFT JOIN daily_hrv v ON v.user_id = h.user_id AND REPLACE(v.date, '-', '') = REPLACE(h.date, '-', '') WHERE h.user_id = ? AND REPLACE(h.date, '-', '') BETWEEN REPLACE(?, '-', '') AND REPLACE(?, '-', '') GROUP BY h.date, h.rhr ORDER BY h.date ASC`,
      [userId, startDay, endDay],
    );
    return rows.map((row) => ({
      date: normalizeDay(row.date as string),
      rhr: (row.rhr ?? null) as number | null,
      hrv: (row.hrv ?? null) as number | null,
    }));
  }

  async getWeeklyFeedbackByDateRange(userId: string, startDay: string, endDay: string): Promise<WeeklyFeedback[]> {
    assertDay(startDay);
    assertDay(endDay);
    if (startDay > endDay) {
      throw new Error(`startDay (${startDay}) must not be after endDay (${endDay})`);
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT week_start, content_md, updated_at
         FROM weekly_feedback
        WHERE user_id = ?
          AND week_start BETWEEN ? AND ?
          AND DATE(updated_at + INTERVAL 8 HOUR) <= ?
        ORDER BY week_start ASC`,
      [userId, startDay, endDay, endDay],
    );
    return rows.map((row) => ({
      weekStart: mysqlDay(row.week_start),
      contentMd: row.content_md as string,
      updatedAt: row.updated_at as Date,
    }));
  }

  /**
   * 全体 active v3 master 计划行（#858 PR-C 夜检扫描枚举面，只读）：content
   * 含 policy 段（滚动内核可跑的 v3 形状）才算——老 v2 行没有滚动可用性段，
   * 扫描对它们无事可做。每用户至多一行 active（master_plan 单 active 不变量）。
   */
  async listActiveMasterPlans(): Promise<Array<{ userId: string; planId: string; content: Record<string, unknown> }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT user_id, plan_id, content
         FROM master_plan
        WHERE content_version = 2 AND status = 'active'
        ORDER BY created_at ASC, plan_id ASC`,
    );
    const active: Array<{ userId: string; planId: string; content: Record<string, unknown> }> = [];
    for (const row of rows) {
      const content = parsePlanContent(row.content, "master_plan");
      if (content.policy === undefined || content.policy === null || typeof content.policy !== "object") continue;
      active.push({ userId: row.user_id as string, planId: row.plan_id as string, content });
    }
    return active;
  }

  /**
   * 该用户某归链 id 的 active 周行 week_start 列表（#858 扫描 dry-run 用，只读；
   * 与 Go 内部 list 端点同数据源——脚本模式避免依赖 Go API 部署可达）。
   */
  async listWeeklyPlanWeekStarts(userId: string, masterPlanId: string): Promise<string[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT week_start FROM weekly_plan WHERE user_id = ? AND status = 'active' AND master_plan_id = ? ORDER BY week_start ASC`,
      [userId, masterPlanId],
    );
    return rows.map((row) => mysqlDay(row.week_start));
  }

  async getMasterPlanMetadataForDate(userId: string, day: string): Promise<ActiveMasterPlanMetadata | null> {
    assertDay(day);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT plan_id, revision, status, content
	         FROM master_plan
	        WHERE user_id = ?
	          AND content_version = 2
	          AND status IN ('active', 'archived')
	        ORDER BY created_at DESC, plan_id DESC`,
      [userId],
    );
    const matches = rows
      .map((row) => ({
        planId: row.plan_id as string,
        revision: row.revision as number,
        status: row.status as string,
        content: parsePlanContent(row.content, "master_plan"),
      }))
      .filter((plan) => masterPlanContainsDay(plan.content, day));
    // Replacing a season plan archives the superseded row over the same dates,
    // so overlapping archived rows are normal and must not be treated as
    // ambiguous: the active plan is the athlete's current one. Only two live
    // candidates make the target week genuinely undecidable.
    const active = matches.filter((plan) => plan.status === "active");
    if (active.length > 1) {
      throw new Error(`multiple master plans cover ${day} for ${userId}`);
    }
    return active[0] ?? matches[0] ?? null;
  }

  /**
   * All activities a user recorded within an inclusive Asia/Shanghai
   * calendar-day range `[startDay, endDay]`, earliest first. Both bounds are
   * `YYYY-MM-DD` Shanghai dates; `userId` is the JWT-`sub` UUID. A single day is
   * `startDay === endDay`.
   */
  /**
   * 区间内活动按 date 升序，`laps` 恒为空（列表查询用，不碰 laps 表）。
   */
  async getActivitySummariesByDateRange(userId: string, startDay: string, endDay: string, options?: { excludeStrength?: boolean }): Promise<Activity[]> {
    assertDay(startDay);
    assertDay(endDay);
    if (startDay > endDay) {
      throw new Error(`startDay (${startDay}) must not be after endDay (${endDay})`);
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT a.user_id, a.label_id, a.name, a.sport_name, a.date,
              a.distance_m, a.duration_s, a.avg_pace_s_km, a.best_km_pace,
              a.max_pace, a.avg_hr, a.max_hr, a.avg_cadence, a.max_cadence,
              a.avg_power, a.max_power, a.avg_step_len_cm, a.ascent_m,
              a.descent_m, t.training_dose AS stride_dose,
              t.session_class AS stride_session_class, a.temperature,
              a.humidity, a.feels_like, a.wind_speed, a.sport_note, a.sport,
              a.feel, a.feel_note, a.vertical_oscillation_mm, a.ground_contact_time_ms,
              a.vertical_ratio_pct, a.pauses, a.provider, ${WATCH_STRENGTH_PREDICATE} AS is_strength
         FROM activities a
         LEFT JOIN activity_training_load t
           ON t.user_id = a.user_id AND t.label_id = a.label_id
        WHERE a.user_id = ? AND DATE(a.date + INTERVAL 8 HOUR) BETWEEN ? AND ?
          ${options?.excludeStrength ? `AND NOT COALESCE(${WATCH_STRENGTH_PREDICATE}, FALSE)` : ""}
        ORDER BY a.date ASC`,
      [userId, startDay, endDay],
    );
    return rows.map(rowToActivity);
  }

  async getManualStrengthSummaries(userId: string, startDay: string, endDay: string): Promise<StrengthRecordSummary[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, name, started_at
         FROM manual_strength_records
        WHERE user_id = ? AND started_at >= ? AND started_at < ?
        ORDER BY started_at, id`,
      [userId, ...shanghaiDateBounds(startDay, endDay)],
    );
    return rows.map((row) => ({ id: row.id as string, name: row.name as string, startedAt: row.started_at as Date }));
  }

  async getManualStrengthDetail(userId: string, recordId: string): Promise<ManualStrengthRecord | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, name, started_at, ended_at, note, actions
         FROM manual_strength_records
        WHERE user_id = ? AND id = ?
        LIMIT 1`,
      [userId, recordId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      startedAt: row.started_at as Date,
      endedAt: row.ended_at as Date,
      note: row.note as string,
      actions: manualStrengthActions.parse(row.actions),
    };
  }

  /**
   * 全量活动（含 `laps` 分段）——给 master/weekly context 等需要完整数据的调用方。
   * 列表/问答场景请用 `getActivitySummariesByDateRange`。
   */
  async getActivitiesByDateRange(userId: string, startDay: string, endDay: string): Promise<Activity[]> {
    const activities = await this.getActivitySummariesByDateRange(userId, startDay, endDay);
    if (activities.length === 0) {
      return [];
    }
    // Fetch every activity's laps in one pass and group by label_id so the
    // response carries per-segment data without N+1 queries.
    const labelIds = [...new Set(activities.map((a) => a.labelId))];
    const placeholders = labelIds.map(() => "?").join(", ");
    const [lapRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT label_id, lap_index, lap_type, distance_m, duration_s, avg_pace,
              adjusted_pace, avg_hr, max_hr, avg_cadence, avg_power, ascent_m,
              descent_m, exercise_type, exercise_name_key, mode
         FROM laps
        WHERE user_id = ? AND label_id IN (${placeholders})
        ORDER BY label_id, lap_index, lap_type`,
      [userId, ...labelIds],
    );
    const lapsByLabel = new Map<string, ActivityLap[]>();
    for (const row of lapRows) {
      const list = lapsByLabel.get(row.label_id as string) ?? [];
      list.push(rowToActivityLap(row));
      lapsByLabel.set(row.label_id as string, list);
    }
    return activities.map((activity) => ({
      ...activity,
      laps: lapsByLabel.get(activity.labelId) ?? [],
    }));
  }

  /**
   * 单条运动的完整明细（含 `laps` 分段），按 `label_id` 精确取。列表查询请用
   * `getActivitySummariesByDateRange`；这里只处理一条，避免把整个日期区间的大段数据拉进上下文。
   */
  async getActivityDetail(
    userId: string,
    labelId: string,
    options?: { includeKilometerSplits?: boolean; excludeStrength?: boolean },
  ): Promise<Activity | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT a.user_id, a.label_id, a.name, a.sport_name, a.date,
              a.distance_m, a.duration_s, a.avg_pace_s_km, a.best_km_pace,
              a.max_pace, a.avg_hr, a.max_hr, a.avg_cadence, a.max_cadence,
              a.avg_power, a.max_power, a.avg_step_len_cm, a.ascent_m,
              a.descent_m, t.training_dose AS stride_dose,
              t.session_class AS stride_session_class, a.temperature,
              a.humidity, a.feels_like, a.wind_speed, a.sport_note, a.sport,
              a.feel, a.feel_note, a.vertical_oscillation_mm, a.ground_contact_time_ms,
              a.vertical_ratio_pct, a.pauses, a.provider, ${WATCH_STRENGTH_PREDICATE} AS is_strength
         FROM activities a
         LEFT JOIN activity_training_load t
           ON t.user_id = a.user_id AND t.label_id = a.label_id
        WHERE a.user_id = ? AND a.label_id = ?
          ${options?.excludeStrength ? `AND NOT COALESCE(${WATCH_STRENGTH_PREDICATE}, FALSE)` : ""}
        LIMIT 1`,
      [userId, labelId],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    const activity = rowToActivity(row);
    const strength = activity.isStrength === true;
    [activity.laps, activity.kilometerSplits] = await Promise.all([
      this.pickSegments(userId, labelId, strength),
      options?.includeKilometerSplits !== false && !strength ? this.readGoKilometerSplits(userId, labelId) : [],
    ]);
    return activity;
  }

  private async readGoKilometerSplits(userId: string, labelId: string): Promise<ActivityLap[]> {
    if (!this.goAPI?.internalToken) return [];
    const { baseUrl, internalToken } = this.goAPI;
    try {
      const response = await fetch(`${baseUrl}/api/${encodeURIComponent(userId)}/activities/${encodeURIComponent(labelId)}`, {
        headers: { "x-internal-token": internalToken },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        logger.warn({ status: response.status }, "Go activity detail unavailable for kilometer splits");
        return [];
      }
      const detail = goActivityDetails.parse(await response.json());
      return (detail.kilometer_splits ?? []).map(rowToActivityLap);
    } catch (error) {
      logger.warn({ error }, "Unable to read kilometer splits from Go activity detail");
      return [];
    }
  }

  /**
   * Choose the activity's split table, mirroring Go's `pickSegments`
   * (src/go/internal/api/activities.go). `type2` is COROS's own lap table — the
   * watch's laps (1 km / 500 m auto splits), a workout's interval reps, or a
   * strength session's exercise groups — and the only family COROS fills
   * distance/pace/HR/cadence in consistently. `autoKm` is the fallback for when
   * `type2` is not a real split table: Garmin writes no `type2` at all, and a
   * COROS activity with auto-lap off has a single lap. The other derived tiers
   * (`autoMile` 5 km, `type12` 10 km) are the same laps re-grouped, return zero
   * distance on a share of activities, and are never read.
   */
  private async pickSegments(userId: string, labelId: string, strength: boolean): Promise<ActivityLap[]> {
    const type2 = await this.lapsByType(userId, labelId, "type2");
    if (strength || hasDistanceSplits(type2)) {
      return type2;
    }
    const autoKm = await this.lapsByType(userId, labelId, "autoKm");
    return hasDistanceSplits(autoKm) ? autoKm : [];
  }

  private async lapsByType(userId: string, labelId: string, lapType: string): Promise<ActivityLap[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT label_id, lap_index, lap_type, distance_m, duration_s, avg_pace,
              adjusted_pace, avg_hr, max_hr, avg_cadence, avg_power, ascent_m,
              descent_m, exercise_type, exercise_name_key, mode
         FROM laps
        WHERE user_id = ? AND label_id = ? AND lap_type = ?
        ORDER BY lap_index`,
      [userId, labelId, lapType],
    );
    return rows.map(rowToActivityLap);
  }

  /**
   * 用户每日 STRIDE 训练负荷（`daily_training_load`），落在 Asia/Shanghai 日历日
   * 区间 `[startDay, endDay]` 内，最早在前。该表 `date` 列已是本地日字符串，直接按
   * 字符串区间过滤（ISO 日期字典序 == 时间序）。回答“负荷/疲劳/恢复/CTL/ATL”这类
   * 问题时用它拿长期负荷、短期负荷、负荷比、form 与就绪度。
   */
  async getDailyTrainingLoadByDateRange(userId: string, startDay: string, endDay: string): Promise<DailyTrainingLoad[]> {
    assertDay(startDay);
    assertDay(endDay);
    if (startDay > endDay) {
      throw new Error(`startDay (${startDay}) must not be after endDay (${endDay})`);
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT date, training_dose, acute_load, chronic_load, form, load_ratio,
              coverage_status
         FROM daily_training_load
        WHERE user_id = ? AND date BETWEEN ? AND ?
        ORDER BY date ASC`,
      [userId, startDay, endDay],
    );
    return rows.map(rowToDailyTrainingLoad);
  }

  /**
   * 确认为比赛的跑步努力，最近在前（devops#790）：取两个显式比赛信号的并集
   * ——`races` 表（race detection 模型打分 + 日历匹配双确认）∪
   * `activity_training_load.session_class='race'`（手表证据分类器）——距离只做
   * `minDistanceKm`（默认 4.5km，取锚桶下界）的噪音地板，不再作为比赛判据。
   * 两信号皆空即无比赛，不设距离兜底。生成赛季计划前用它回看运动员的历史比赛表现。
   */
  async getRaceHistory(userId: string, options: { asOfDate: string; minDistanceKm?: number; limit?: number }): Promise<RaceEffort[]> {
    assertDay(options.asOfDate);
    const minDistanceM = Math.round((options.minDistanceKm ?? 4.5) * 1000);
    const limit = Math.min(Math.max(options.limit ?? 15, 1), 100);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT DATE(a.date + INTERVAL 8 HOUR) AS sh_day, a.label_id, a.name, a.sport,
              a.distance_m, a.duration_s, a.avg_pace_s_km, a.avg_hr, a.max_hr, a.feel,
              (r.label_id IS NOT NULL) AS from_races, (t.session_class = 'race') AS from_class
         FROM activities a
         LEFT JOIN races r ON r.user_id = a.user_id AND r.label_id = a.label_id
         LEFT JOIN activity_training_load t ON t.user_id = a.user_id AND t.label_id = a.label_id
        WHERE a.user_id = ?
          AND a.sport LIKE 'run%'
          AND a.distance_m >= ?
          AND (r.label_id IS NOT NULL OR t.session_class = 'race')
          AND DATE(a.date + INTERVAL 8 HOUR) <= ?
        ORDER BY a.date DESC
        LIMIT ?`,
      [userId, minDistanceM, options.asOfDate, limit],
    );
    return rows.map(rowToRaceEffort);
  }

  /** 运动员各标准距离的个人最好成绩（`personal_bests`），作为比赛表现的参照系。 */
  async getPersonalBests(userId: string, asOfDate: string): Promise<PersonalBest[]> {
    assertDay(asOfDate);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT distance, pb_time_sec, achieved_at,
			        JSON_UNQUOTE(JSON_EXTRACT(entry_json, '$.label_id')) AS activity_label_id
         FROM personal_bests
	       WHERE user_id = ? AND achieved_at <= ?
	       ORDER BY pb_time_sec ASC`,
      [userId, asOfDate],
    );
    return rows.map((r) => {
      if (typeof r.activity_label_id !== "string" || r.activity_label_id.length === 0) {
        throw new Error(`personal best ${String(r.distance)} has no activity label ID`);
      }
      return {
        distance: r.distance as string,
        timeSec: Math.round(Number(r.pb_time_sec) * 10) / 10,
        achievedAt: (r.achieved_at ?? null) as string | null,
        activityLabelId: r.activity_label_id,
      };
    });
  }

  /**
   * Ordinary Coach reads always resolve active; candidate is an explicit offline adapter call.
   * Per-user override precedence (#999): an active `running_calibration_user_override`
   * row pins one (algorithm_version, algorithm_revision) identity that is read — revision
   * in the WHERE clause — ahead of the global preferred/fallback chain, mirroring Go
   * `ReadEffectiveRunningCalibration` exactly. A pinned identity with no snapshot at/below
   * the cutoff falls back to the global selection with reason `override_snapshot_missing`,
   * so a today-published revision never backfills history. Candidate reads never consult
   * the override.
   */
  async getLatestRunningCalibration(userId: string, asOfDate: string, mode: "active" | "candidate" = "active"): Promise<RunningCalibration | null> {
    if (mode !== "active" && mode !== "candidate") throw new Error("invalid calibration selection mode");
    const cutoff = assertDay(shanghaiDay(asOfDate));
    const connection = await this.pool.getConnection();
    try {
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await connection.query("START TRANSACTION READ ONLY");
      const [policyRows] = await connection.query<RowDataPacket[]>(
        "SELECT active_version, candidate_version, fallback_version, revision FROM running_calibration_policy WHERE policy_key = ? LIMIT 1",
        ["running_baseline"],
      );
      const policy = policyRows[0] ?? { ...policyContract, revision: 0 };
      if (
        !policyContract.supported_versions.includes(Number(policy.active_version)) ||
        Number(policy.fallback_version) !== policyContract.fallback_version ||
        (policy.candidate_version !== null && !policyContract.supported_versions.includes(Number(policy.candidate_version)))
      ) {
        throw new Error("unsupported calibration policy versions");
      }
      let override: { revision: number; algorithm_version: number; algorithm_revision: string } | undefined;
      if (mode === "active") {
        const [overrideRows] = await connection.query<RowDataPacket[]>(
          `SELECT revision, algorithm_version, algorithm_revision
             FROM ${policyContract.user_override.table}
            WHERE user_id = ? AND status = ? LIMIT 1`,
          [userId, policyContract.user_override.active_status],
        );
        const row = overrideRows[0];
        if (row) {
          const revision = String(row.algorithm_revision ?? "");
          if (!/^[A-Za-z0-9._-]{0,64}$/.test(revision) || !policyContract.supported_versions.includes(Number(row.algorithm_version))) {
            throw new Error("unsupported calibration user override identity");
          }
          override = { revision: Number(row.revision), algorithm_version: Number(row.algorithm_version), algorithm_revision: revision };
        }
      }
      const preferred = mode === "active" ? Number(policy.active_version) : policy.candidate_version === null ? null : Number(policy.candidate_version);
      const requested = override ? override.algorithm_version : preferred;
      const fallback = Number(policy.fallback_version);
      // Selection chain mirroring Go: the pinned override identity first, then
      // the global preferred version, then the global fallback. Pinned targets
      // filter by algorithm_revision; global targets keep the latest-row tiebreak.
      const targets: Array<{ version: number; revision?: string }> = [];
      if (override) targets.push({ version: override.algorithm_version, revision: override.algorithm_revision });
      if (preferred !== null) targets.push({ version: preferred });
      if (preferred === null || preferred !== fallback) targets.push({ version: fallback });
      let snapshot: RowDataPacket | undefined;
      let winner = -1;
      for (const [index, target] of targets.entries()) {
        const [rows] = await connection.query<RowDataPacket[]>(
          `SELECT id, as_of_date, algorithm_version, algorithm_revision,
                  DATE_FORMAT(computed_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS computed_at, source_json,
                  threshold_hr, threshold_speed_mps, rhr_baseline, threshold_hr_confidence, threshold_speed_confidence
             FROM running_calibration_snapshot
            WHERE user_id = ? AND algorithm_version = ? AND as_of_date <= ?
              ${target.revision !== undefined ? "AND algorithm_revision = ?" : ""}
            ORDER BY as_of_date DESC, id DESC LIMIT 1`,
          target.revision !== undefined ? [userId, target.version, cutoff, target.revision] : [userId, target.version, cutoff],
        );
        snapshot = rows[0];
        if (snapshot) {
          winner = index;
          break;
        }
      }
      if (!snapshot) {
        await connection.commit();
        return null;
      }
      const [paceRows] = await connection.query<RowDataPacket[]>(
        `SELECT name, min_pace_s_per_km, max_pace_s_per_km FROM running_calibration_pace_zone
          WHERE user_id = ? AND snapshot_id = ? ORDER BY name ASC`,
        [userId, snapshot.id],
      );
      const [hrRows] = await connection.query<RowDataPacket[]>(
        `SELECT name, min_bpm, max_bpm FROM running_calibration_hr_zone
          WHERE user_id = ? AND snapshot_id = ? ORDER BY name ASC`,
        [userId, snapshot.id],
      );
      const source = calibrationSource(snapshot.source_json);
      const effective = Number(snapshot.algorithm_version);
      const isSelected = winner === 0;
      const reason = isSelected
        ? undefined
        : override
          ? policyContract.user_override.fallback_reason
          : requested === null
            ? "candidate_not_configured"
            : "preferred_snapshot_missing";
      const result: RunningCalibration = {
        calibrationId: Number(snapshot.id),
        algorithmVersion: effective,
        computedAt: snapshot.computed_at instanceof Date ? snapshot.computed_at.toISOString() : String(snapshot.computed_at),
        selection: {
          mode,
          policy_revision: Number(policy.revision),
          requested_version: requested,
          effective_version: effective,
          state: isSelected ? "selected" : "fallback",
          ...(reason ? { reason } : {}),
          ...(override
            ? { override: { revision: override.revision, algorithm_version: override.algorithm_version, algorithm_revision: override.algorithm_revision } }
            : {}),
        },
        source,
        ...(source.fingerprint ? { fingerprint: source.fingerprint } : {}),
        asOfDate: snapshot.as_of_date as string,
        thresholdHr: (snapshot.threshold_hr ?? null) as number | null,
        thresholdSpeedMps: (snapshot.threshold_speed_mps ?? null) as number | null,
        rhrBaseline: (snapshot.rhr_baseline ?? null) as number | null,
        thresholdHrConfidence: snapshot.threshold_hr_confidence as string,
        thresholdSpeedConfidence: snapshot.threshold_speed_confidence as string,
        paceZones: paceRows.map(rowToPaceZone),
        heartRateZones: hrRows.map(rowToHeartRateZone),
      };
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  /** Structured season plan covering the requested day, or null. */
  async getMasterPlan(userId: string, day: string): Promise<MasterPlanDocument | null> {
    return (await this.getMasterPlanMetadataForDate(userId, day))?.content ?? null;
  }

  /**
   * Active structured weekly plan for `weekName` (`YYYY-MM-DD_MM-DD`), or null.
   * MySQL stores the week start only, so the caller-facing week identity is
   * reduced to its Monday date before querying.
   */
  async getPlanSessions(userId: string, dateFrom: string, dateTo: string): Promise<DaySessionRow[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT w.workout_id,
              w.date,
              w.source,
              w.kind,
              w.name,
              w.summary,
              w.spec_json,
              w.save_token,
              EXISTS(SELECT 1 FROM scheduled_workout s
                      WHERE s.user_id = w.user_id AND s.status = 'pushed'
                        AND ((s.workout_id IS NOT NULL AND s.workout_id = w.workout_id)
                          OR (s.workout_id IS NULL AND s.planned_date = w.date
                              AND w.source = 'weekly' AND s.session_index <=> w.session_index))) AS pushed
         FROM workout w
        WHERE w.user_id = ? AND w.status = 'active' AND w.date BETWEEN ? AND ?
        ORDER BY FIELD(w.source, 'weekly', 'custom', 'watch'), w.created_at`,
      [userId, dateFrom, dateTo],
    );
    return rows.map((r) => ({
      workout_id: String(r.workout_id),
      date: String(r.date),
      source: r.source,
      kind: String(r.kind),
      name: String(r.name),
      summary: r.summary ?? null,
      spec_json: r.spec_json ?? null,
      save_token: r.save_token ?? null,
      pushed: Number(r.pushed) === 1,
    }));
  }

  async getWeeklyPlan(userId: string, weekName: string): Promise<WeeklyPlanDocument | null> {
    const weekStart = weekName.slice(0, 10);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT content
         FROM weekly_plan
        WHERE user_id = ? AND week_start = ? AND content_version = 2 AND status = 'active'
        LIMIT 1`,
      [userId, weekStart],
    );
    const row = rows[0];
    return row ? parsePlanContent(row.content, "weekly_plan") : null;
  }

  async getRaceTarget(userId: string): Promise<RaceTarget | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT goal_id, user_id, status,
				        DATE_FORMAT(race_date, '%Y-%m-%d') AS race_date,
				        race_distance, race_name, target_finish_time, weekly_training_days
         FROM race_goal
        WHERE user_id = ? and status = 'active'
        ORDER BY race_date DESC
        LIMIT 1`,
      [userId],
    );
    return rows.length === 0 ? null : (rows[0] as RaceTarget);
  }

  /**
   * 赛事问答和比赛策略共用的赛历详情，包含事件、项目与城市内容。
   * 只返回已发布的赛事。
   */
  async getRaceCalendarContext(raceEventId: number): Promise<RaceCalendarContext | null> {
    const [eventRows, itemRows] = await Promise.all([
      this.pool.query<RowDataPacket[]>(
        `SELECT id, name, name_cn, race_date, province, city, climate, content_source
           FROM race_calendar
          WHERE id = ? AND published = 1
          LIMIT 1`,
        [raceEventId],
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT name, type, distance_km, start_point, finish_point, route_description,
                total_ascent_m, elevation_points, course_challenges, reputation, aid_stations, cutoffs, content_source
           FROM race_calendar_item
          WHERE race_event_id = ?
          ORDER BY id ASC`,
        [raceEventId],
      ),
    ]);
    const event = eventRows[0][0];
    if (!event) return null;

    let cityContent: RaceCalendarContext["city_content"] = null;
    if (event.city) {
      const [cityRows] = await this.pool.query<RowDataPacket[]>(`SELECT city, intro FROM race_city_content WHERE city = ? LIMIT 1`, [event.city]);
      const city = cityRows[0];
      if (city) {
        const intro = parseJsonObject(city.intro, "race_city_content.intro");
        cityContent = {
          city: city.city as string,
          overview: stringField(intro?.overview),
          food: stringField(intro?.food),
        };
      }
    }

    return {
      race_event_id: raceEventId,
      name: event.name as string,
      name_cn: (event.name_cn ?? null) as string | null,
      race_date: normalizeDay(event.race_date as string),
      province: (event.province ?? null) as string | null,
      city: (event.city ?? null) as string | null,
      climate: parseJsonObject(event.climate, "race_calendar.climate"),
      content_source: (event.content_source ?? null) as string | null,
      items: itemRows[0].map(rowToRaceItemContent),
      city_content: cityContent,
    };
  }

  async searchRaceCalendar(options: RaceCalendarSearchQuery): Promise<RaceCalendarSummary[]> {
    const dateFrom = assertDay(options.dateFrom ?? options.asofDate);
    const dateTo = assertDay(options.dateTo ?? dayShift(dateFrom, 90));
    if (dateFrom > dateTo) {
      throw new Error(`dateFrom (${dateFrom}) must not be after dateTo (${dateTo})`);
    }
    // limit 与工具 schema 同界（1..20）：非工具路径直调也保持检索有界。
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 20);

    // 固定日期窗让检索永远时间有界（QA 侧无「全库枚举」敞口）；其余过滤按传入拼接。
    const where: string[] = ["published = 1", "race_date BETWEEN ? AND ?"];
    const values: unknown[] = [dateFrom, dateTo];
    if (options.keyword !== undefined) {
      // LIKE 通配符当字面量用：用户输入里的 % _ \ 一律转义后再包 %…%。
      const pattern = `%${options.keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      where.push("(name LIKE ? ESCAPE '\\\\' OR name_cn LIKE ? ESCAPE '\\\\')");
      values.push(pattern, pattern);
    }
    if (options.city !== undefined) {
      where.push("city = ?");
      values.push(options.city);
    }
    if (options.itemType !== undefined) {
      where.push("id IN (SELECT race_event_id FROM race_calendar_item WHERE type = ?)");
      values.push(options.itemType);
    }
    values.push(limit);

    const [eventRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, name, name_cn, race_date, province, city
         FROM race_calendar
        WHERE ${where.join(" AND ")}
        ORDER BY race_date ASC, id ASC
        LIMIT ?`,
      values,
    );
    if (eventRows.length === 0) return [];

    // 摘要只要项目类型+距离，第二条 IN 查询按事件拼回（不 JOIN 展开，LIMIT 语义不破）。
    const [itemRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT race_event_id, type, distance_km
         FROM race_calendar_item
        WHERE race_event_id IN (${eventRows.map(() => "?").join(", ")})
        ORDER BY race_event_id ASC, id ASC`,
      eventRows.map((row) => row.id),
    );
    const itemsByEvent = new Map<number, Array<{ item_type: string; distance_km: number | null }>>();
    for (const row of itemRows) {
      const items = itemsByEvent.get(row.race_event_id as number) ?? [];
      items.push({ item_type: row.type as string, distance_km: (row.distance_km ?? null) as number | null });
      itemsByEvent.set(row.race_event_id as number, items);
    }
    return eventRows.map((row) => ({
      race_event_id: row.id as number,
      name: row.name as string,
      name_cn: (row.name_cn ?? null) as string | null,
      race_date: normalizeDay(row.race_date as string),
      province: (row.province ?? null) as string | null,
      city: (row.city ?? null) as string | null,
      items: itemsByEvent.get(row.id as number) ?? [],
    }));
  }

  /**
   * 运动员成绩基线：race_predictions 全量（每距离一行）+ 最近一天整组 ability
   * L4（90 天窗）+ 最新跑步校准。三源各自缺项为 null/空数组——由策略代理在
   * basis_note 里声明依据缺口，而不是在此处报错。
   */
  async getPerformanceBaseline(userId: string, asOfDate: string): Promise<PerformanceBaseline> {
    assertDay(asOfDate);
    const windowStart = dayShift(asOfDate, -90);
    const [predictionRows, l4Rows, calibration] = await Promise.all([
      this.pool.query<RowDataPacket[]>(
        `SELECT race_type, duration_s, avg_pace
           FROM race_predictions
          WHERE user_id = ?`,
        [userId],
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT date, dimension, value
           FROM ability_snapshot
          WHERE user_id = ? AND level = 'L4'
            AND dimension IN ('composite', 'marathon_training_s', 'marathon_race_s', 'hm_race_s')
            AND date BETWEEN ? AND ?
          ORDER BY date DESC`,
        [userId, windowStart, asOfDate],
      ),
      this.getLatestRunningCalibration(userId, asOfDate),
    ]);

    const predictions: RacePredictionRow[] = predictionRows[0].map((row) => ({
      race_type: row.race_type as string,
      duration_s: (row.duration_s ?? null) as number | null,
      avg_pace_s_km: (row.avg_pace ?? null) as number | null,
    }));

    // L4 行按「最近一天」整组取：同一天的 composite/marathon_*/hm_* 是一次
    // 计算的快照，跨天拼接会混合两次快照。
    const latestDate = l4Rows[0][0]?.date as string | undefined;
    let abilityL4: AbilityL4Baseline | null = null;
    if (latestDate) {
      const dims = new Map<string, number>();
      for (const row of l4Rows[0]) {
        if (row.date !== latestDate) continue;
        if (row.value !== null && row.value !== undefined) {
          dims.set(row.dimension as string, Number(row.value));
        }
      }
      abilityL4 = {
        as_of_date: normalizeDay(latestDate),
        composite: dims.get("composite") ?? null,
        marathon_training_s: dims.get("marathon_training_s") ?? null,
        marathon_race_s: dims.get("marathon_race_s") ?? null,
        hm_race_s: dims.get("hm_race_s") ?? null,
      };
    }

    return {
      as_of_date: asOfDate,
      race_predictions: predictions,
      ability_l4: abilityL4,
      running_calibration: calibration,
    };
  }

  /**
   * 首次同步覆盖快照（devops#1013）：只读 Go-owned onboarding sync 四张表，
   * 推导交给 @stride/coach-agent 的 deriveSyncCoverage（与 Go GET view 同语义）。
   * 无 session（老用户 / 分阶段同步未开）返回 null——null ≠ 数据不存在。
   */
  async getSyncCoverage(userId: string): Promise<SyncCoverage | null> {
    const [sessionRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT session_id, provider, binding_revision, anchor_day, state, shell_ready, last_error, updated_at, created_at, historical_analysis_reason
         FROM onboarding_sync_sessions
        WHERE user_id = ? AND state <> 'superseded'
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId],
    );
    const sessionRow = sessionRows[0] as (SyncSessionRow & { created_at: Date }) | undefined;
    if (!sessionRow) return null;
    const sessionId = sessionRow.session_id;
    const [coverageRows, dispatchRows, analysisRows] = await Promise.all([
      this.pool.query<RowDataPacket[]>(
        `SELECT stage, status, target_from, target_to, scanned_from, scanned_to,
                observed_from, observed_to, gaps_json, last_error
           FROM onboarding_sync_stage_coverage
          WHERE session_id = ?
          ORDER BY stage ASC`,
        [sessionId],
      ),
      this.pool.query<RowDataPacket[]>(`SELECT stage, status FROM onboarding_sync_dispatches WHERE session_id = ?`, [sessionId]),
      this.pool.query<RowDataPacket[]>(
        `SELECT as_of_day, status, stale, domains_json, coverage_from, coverage_to, input_fingerprint, computed_at
           FROM onboarding_recent_analysis
          WHERE session_id = ?
          LIMIT 1`,
        [sessionId],
      ),
    ]);
    const analysisRow = analysisRows[0][0] as SyncRecentAnalysisRow | undefined;
    const coverage = coverageRows[0] as unknown as SyncStageCoverageRow[];
    const historical = await this.readHistoricalSyncAnalysis(userId, sessionRow, coverage, analysisRow);
    return deriveSyncCoverage(sessionRow, coverage, dispatchRows[0] as unknown as SyncDispatchRow[], analysisRow ?? null, historical);
  }

  // Mirror Go's read-only projection from frozen and published runs. The old
  // recent snapshot remains intact, including its own as-of day and gaps.
  private async readHistoricalSyncAnalysis(
    userId: string,
    session: SyncSessionRow & { created_at: Date },
    coverage: SyncStageCoverageRow[],
    analysis: SyncRecentAnalysisRow | undefined,
  ): Promise<Parameters<typeof deriveSyncCoverage>[4]> {
    const terminal = (stage: string) => coverage.some((row) => row.stage === stage && (row.status === "completed" || row.status === "completed_with_gaps"));
    if (!terminal("historical_raw")) return undefined;
    const [runs] = await this.pool.query<RowDataPacket[]>(
      `SELECT m.run_id, m.state, m.published_at, m.analysis_as_of_day, m.target_from_day, m.target_to_day
         FROM historical_metrics_recompute_runs AS m
         JOIN historical_recompute_runs AS c
           ON c.run_id = m.calibration_run_id AND c.user_id = m.user_id
          AND c.binding_revision = m.binding_revision
          AND c.bundle_fingerprint = m.calibration_bundle_fingerprint
          AND c.state IN ('completed', 'completed_with_gaps')
        WHERE m.state IN ('completed', 'completed_with_gaps')
          AND m.published_at IS NOT NULL AND m.output_fingerprint IS NOT NULL
          AND m.user_id = ? AND m.binding_revision = ? AND m.created_at >= ?
        ORDER BY m.published_at DESC, m.run_id DESC LIMIT 1`,
      [userId, session.binding_revision, session.created_at],
    );
    const run = runs[0];
    if (run) {
      const readiness: SyncReadiness = run.state === "completed_with_gaps" ? "ready_with_gaps" : "ready";
      if (
        !analysis?.domains_json?.includes("historical_calibration_missing") ||
        new Date(analysis.computed_at) > new Date(run.published_at) ||
        analysis.as_of_day < run.target_from_day ||
        analysis.as_of_day > run.target_to_day
      )
        return { readiness };

      const withinWindow =
        analysis.coverage_from && analysis.coverage_to && analysis.coverage_from >= run.target_from_day && analysis.coverage_to <= run.target_to_day;
      const from = withinWindow ? analysis.coverage_from : run.target_to_day;
      const to = withinWindow ? analysis.coverage_to : run.target_from_day;
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS activities,
                COALESCE(SUM(artifact.kind = 'activity_load' AND l.training_dose IS NOT NULL
                  AND JSON_TYPE(JSON_EXTRACT(artifact.payload, '$.TrainingDose')) IN ('INTEGER', 'DOUBLE', 'DECIMAL')
                  AND JSON_UNQUOTE(JSON_EXTRACT(artifact.payload, '$.ExcludedFromPMC')) = 'false'), 0) AS loads,
                COALESCE(SUM(EXISTS (
                  SELECT 1 FROM historical_metrics_recompute_staged z
                  JOIN activity_zones az ON az.user_id = a.user_id AND az.label_id = a.label_id
                  WHERE z.run_id = artifact.run_id AND z.kind = 'activity_zones' AND z.item_key = a.label_id
                    AND JSON_CONTAINS(z.payload, '{"ZoneType":"heartRate"}')
                    AND az.zone_type = 'heartRate'
                )), 0) AS zones,
                EXISTS (SELECT 1 FROM ability_snapshot ability
                  WHERE ability.user_id = ? AND ability.date = ? AND ? AND ability.level = 'L4'
                    AND ability.value IS NOT NULL AND ability.computed_at >= ?) AS has_ability
           FROM historical_metrics_recompute_staged artifact
           JOIN activities a ON a.user_id = ? AND a.label_id = artifact.item_key
           LEFT JOIN activity_training_load l ON l.user_id = a.user_id AND l.label_id = a.label_id
          WHERE artifact.run_id = ? AND artifact.kind IN ('activity_load', 'activity_skip')
            AND DATE(a.date + INTERVAL 8 HOUR) BETWEEN ? AND ?`,
        [userId, analysis.as_of_day, analysis.as_of_day === run.analysis_as_of_day, run.published_at, userId, run.run_id, from, to],
      );
      const evidence = rows[0];
      return {
        readiness,
        recentEvidence: {
          activities: Number(evidence?.activities ?? 0),
          loads: Number(evidence?.loads ?? 0),
          zones: Number(evidence?.zones ?? 0),
          ability: Boolean(evidence?.has_ability),
        },
      };
    }
    if (!terminal("auxiliary") || session.historical_analysis_reason) return undefined;
    const [runsInProgress] = await this.pool.query<RowDataPacket[]>(
      `SELECT last_job_id, updated_at FROM historical_recompute_runs
        WHERE user_id = ? AND binding_revision = ? AND created_at >= ? AND state IN ('pending', 'running')
        UNION ALL
        SELECT last_job_id, updated_at FROM historical_metrics_recompute_runs
        WHERE user_id = ? AND binding_revision = ? AND created_at >= ? AND state IN ('pending', 'running')`,
      [userId, session.binding_revision, session.created_at, userId, session.binding_revision, session.created_at],
    );
    const cutoff = Date.now() - 15 * 60 * 1000;
    if (runsInProgress.some((candidate) => new Date(candidate.updated_at).getTime() >= cutoff)) return { readiness: "running" };
    const jobIDs = runsInProgress.flatMap((candidate) => (typeof candidate.last_job_id === "string" ? [candidate.last_job_id] : []));
    if (!this.goAPI?.internalToken || jobIDs.length === 0) return { readiness: "pending" };

    // Go owns job state. Check its lease when a real chunk outlives the
    // checkpoint freshness window (including manual runs with auto disabled).
    const jobs = new GoJobClient(this.goAPI.baseUrl, this.goAPI.internalToken, (input, options) =>
      fetch(input, { ...options, redirect: "error", signal: AbortSignal.timeout(3_000) }),
    );
    const observed = await Promise.all(jobIDs.map((id) => jobs.get(id).catch(() => null)));
    const active = observed.some((job) => job?.userId === userId && job.status === "running" && (job.heartbeatAt ?? job.updatedAt).getTime() >= cutoff);
    return { readiness: active ? "running" : "pending" };
  }

  /** Release the pool — only if this provider opened it via `create()`. */
  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

function normalizeDay(day: string): string {
  return day.length === 8 ? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}` : day;
}

function dayShift(day: string, deltaDays: number): string {
  const shifted = new Date(Date.parse(`${day}T00:00:00Z`) + deltaDays * 86400_000);
  return shifted.toISOString().slice(0, 10);
}

/** JSON 列的宽容解析：mysql2 对 MySQL JSON 类型通常已解析成对象，字符串则再 parse。 */
function parseJsonObject(value: unknown, source: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (value.length === 0) return null;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${source} contains invalid JSON`);
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rowToRaceItemContent(row: RowDataPacket): RaceCalendarItemContent {
  return {
    item_type: row.type as string,
    name: row.name as string,
    distance_km: (row.distance_km ?? null) as number | null,
    start_point: pointName(row.start_point),
    finish_point: pointName(row.finish_point),
    route_description: stringField(row.route_description),
    total_ascent_m: (row.total_ascent_m ?? null) as number | null,
    elevation_points: parseJsonArray<RaceElevationPoint>(row.elevation_points, "elevation_points"),
    course_challenges: parseJsonArray<RaceCourseChallenge>(row.course_challenges, "course_challenges"),
    reputation: parseRaceReputation(row.reputation),
    aid_stations: parseJsonArray<RaceAidStation>(row.aid_stations, "aid_stations"),
    cutoffs: parseJsonArray<RaceCutoff>(row.cutoffs, "cutoffs"),
    content_source: (row.content_source ?? null) as string | null,
  };
}

function parseRaceReputation(value: unknown): RaceCalendarItemContent["reputation"] {
  try {
    const result = raceReputationJson.safeParse(parseJsonObject(value, "race_calendar_item.reputation"));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** RacePoint 列只取名称（策略只需要「从哪到哪」，坐标不进 LLM 上下文）。 */
function pointName(value: unknown): string | null {
  const parsed = parseJsonObject(value, "race_calendar_item point");
  return parsed === null ? null : stringField(parsed.name);
}

function parseJsonArray<T>(value: unknown, source: string): T[] {
  if (value === null || value === undefined) return [];
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (value.length === 0) return [];
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${source} contains invalid JSON`);
    }
  }
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function parsePlanContent(content: unknown, table: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = typeof content === "string" ? JSON.parse(content) : content;
  } catch {
    throw new Error(`${table} contains invalid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${table} content must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function masterPlanContainsDay(content: MasterPlanDocument, day: string): boolean {
  const record = content as Record<string, unknown>;
  const start = typeof record.start_date === "string" ? record.start_date : null;
  const end = typeof record.end_date === "string" ? record.end_date : null;
  if (start !== null && end !== null) return start <= day && day <= end;
  const phases = Array.isArray(record.phases) ? record.phases : [];
  return phases.some((phase) => {
    if (typeof phase !== "object" || phase === null) return false;
    const value = phase as Record<string, unknown>;
    return typeof value.start_date === "string" && typeof value.end_date === "string" && value.start_date <= day && day <= value.end_date;
  });
}

function shanghaiDateBounds(startDay: string, endDay: string): [Date, Date] {
  assertDay(startDay);
  assertDay(endDay);
  if (startDay > endDay) throw new Error(`startDay (${startDay}) must not be after endDay (${endDay})`);
  // The lower bound for all-history lookups cannot precede MySQL DATETIME.
  const lower = startDay === "1000-01-01" ? new Date("1000-01-01T00:00:00Z") : new Date(`${startDay}T00:00:00+08:00`);
  return [lower, new Date(`${addDays(endDay, 1)}T00:00:00+08:00`)];
}

function rowToActivity(row: RowDataPacket): Activity {
  // 时区换算唯一落点（devops#936）：上海日历日在此算好，下游只读 shanghaiDay。
  // 前提：注入的 pool 走 createStridePool（timezone:"Z"），row.date 是 UTC instant。
  const date = row.date as Date;
  return {
    userId: row.user_id as string,
    labelId: row.label_id as string,
    name: (row.name ?? null) as string | null,
    sportName: (row.sport_name ?? null) as string | null,
    date,
    shanghaiDay: shanghaiDay(date),
    distanceM: (row.distance_m ?? null) as number | null,
    durationS: (row.duration_s ?? null) as number | null,
    avgPaceSKm: (row.avg_pace_s_km ?? null) as number | null,
    bestKmPace: (row.best_km_pace ?? null) as number | null,
    maxPace: (row.max_pace ?? null) as number | null,
    avgHr: (row.avg_hr ?? null) as number | null,
    maxHr: (row.max_hr ?? null) as number | null,
    avgCadence: (row.avg_cadence ?? null) as number | null,
    maxCadence: (row.max_cadence ?? null) as number | null,
    avgPower: (row.avg_power ?? null) as number | null,
    maxPower: (row.max_power ?? null) as number | null,
    avgStepLenCm: (row.avg_step_len_cm ?? null) as number | null,
    ascentM: (row.ascent_m ?? null) as number | null,
    descentM: (row.descent_m ?? null) as number | null,
    strideDose: (row.stride_dose ?? null) as number | null,
    strideSessionClass: (row.stride_session_class ?? null) as string | null,
    temperature: (row.temperature ?? null) as number | null,
    humidity: (row.humidity ?? null) as number | null,
    feelsLike: (row.feels_like ?? null) as number | null,
    windSpeed: (row.wind_speed ?? null) as number | null,
    sportNote: (row.sport_note ?? null) as string | null,
    sport: (row.sport ?? null) as string | null,
    ...(row.is_strength ? { isStrength: true } : {}),
    feel: (row.feel ?? null) as number | null,
    feelNote: (row.feel_note ?? null) as string | null,
    verticalOscillationMm: (row.vertical_oscillation_mm ?? null) as number | null,
    groundContactTimeMs: (row.ground_contact_time_ms ?? null) as number | null,
    verticalRatioPct: (row.vertical_ratio_pct ?? null) as number | null,
    pauses: (row.pauses ?? null) as unknown | null,
    provider: row.provider as string,
    laps: [],
  };
}

function rowToActivityLap(row: Record<string, unknown>): ActivityLap {
  return {
    lapIndex: row.lap_index as number,
    lapType: (row.lap_type ?? null) as string | null,
    distanceM: (row.distance_m ?? null) as number | null,
    durationS: (row.duration_s ?? null) as number | null,
    avgPace: (row.avg_pace ?? null) as number | null,
    adjustedPace: (row.adjusted_pace ?? null) as number | null,
    avgHr: (row.avg_hr ?? null) as number | null,
    maxHr: (row.max_hr ?? null) as number | null,
    avgCadence: (row.avg_cadence ?? null) as number | null,
    avgPower: (row.avg_power ?? null) as number | null,
    ascentM: (row.ascent_m ?? null) as number | null,
    descentM: (row.descent_m ?? null) as number | null,
    exerciseType: (row.exercise_type ?? null) as number | null,
    exerciseNameKey: (row.exercise_name_key ?? null) as string | null,
    mode: (row.mode ?? null) as number | null,
  };
}

/**
 * A lap family is usable as a split table only when at least two of its laps
 * carry a positive distance. A single-lap family is not a split table, and a
 * family whose distances are all zero (COROS's derived tiers, strength exercise
 * groups) must not be served as one. Mirrors Go's `hasDistanceSplits`.
 */
function hasDistanceSplits(laps: ActivityLap[]): boolean {
  let withDistance = 0;
  for (const lap of laps) {
    if (lap.distanceM !== null && lap.distanceM > 0) {
      withDistance += 1;
      if (withDistance >= 2) {
        return true;
      }
    }
  }
  return false;
}

function rowToDailyTrainingLoad(row: RowDataPacket): DailyTrainingLoad {
  return {
    date: row.date as string,
    trainingDose: (row.training_dose ?? 0) as number,
    acuteLoad: (row.acute_load ?? null) as number | null,
    chronicLoad: (row.chronic_load ?? null) as number | null,
    form: (row.form ?? null) as number | null,
    loadRatio: (row.load_ratio ?? null) as number | null,
    coverageStatus: row.coverage_status as string,
  };
}

function rowToRaceEffort(row: RowDataPacket): RaceEffort {
  const distanceM = (row.distance_m ?? null) as number | null;
  const durationS = (row.duration_s ?? null) as number | null;
  return {
    date: mysqlDay(row.sh_day),
    labelId: row.label_id as string,
    name: (row.name ?? null) as string | null,
    sport: (row.sport ?? null) as string | null,
    distanceKm: distanceM === null ? null : Math.round(distanceM / 100) / 10,
    durationMin: durationS === null ? null : Math.round(durationS / 6) / 10,
    avgPaceSKm: (row.avg_pace_s_km ?? null) as number | null,
    avgHr: (row.avg_hr ?? null) as number | null,
    maxHr: (row.max_hr ?? null) as number | null,
    feel: (row.feel ?? null) as number | null,
    source: { races: row.from_races === 1, sessionClass: row.from_class === 1 },
  };
}

function mysqlDay(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return normalizeDay(String(value));
}

function rowToPaceZone(row: RowDataPacket): PaceZone {
  return {
    name: row.name as string,
    minPaceSPerKm: (row.min_pace_s_per_km ?? null) as number | null,
    maxPaceSPerKm: (row.max_pace_s_per_km ?? null) as number | null,
  };
}

function rowToHeartRateZone(row: RowDataPacket): HeartRateZone {
  return {
    name: row.name as string,
    minBpm: (row.min_bpm ?? null) as number | null,
    maxBpm: (row.max_bpm ?? null) as number | null,
  };
}

/** Decode only Go-owned summary fields; unknown/raw fields never reach model context. */
function calibrationSource(raw: unknown) {
  if (raw === null || raw === undefined || raw === "") return { schema_version: 0, state: "legacy_source_missing" };
  let decoded: unknown;
  try {
    decoded = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { schema_version: 0, state: "source_unavailable" };
  }
  if (decoded === null) return { schema_version: 0, state: "legacy_source_missing" };
  const parsed = CalibrationSourceSchema.safeParse(decoded);
  if (!parsed.success) return { schema_version: 0, state: "source_unavailable" };
  const source = parsed.data;
  if (source.schema_version !== 1 || source.state !== "available" || !source.strategy || !source.data_cutoff_day) {
    return { schema_version: 0, state: "legacy_source_missing" };
  }
  return source;
}
