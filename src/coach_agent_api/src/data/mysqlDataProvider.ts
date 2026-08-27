/** MySQL adapter for the Coach Agent read-only DataProvider seam. */
import type {
  ActiveMasterPlanMetadata,
  Activity,
  DailyRecovery,
  DailyTrainingLoad,
  DataProvider,
  HeartRateZone,
  MasterPlanDocument,
  PaceZone,
  PersonalBest,
  RaceEffort,
  RaceTarget,
  RunningCalibration,
  UserInjury,
  UserProfile,
  VendorHrvBaseline,
  WeeklyFeedback,
  WeeklyPlanDocument,
} from "coach_agent";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type { MySqlConfig } from "../dto/config.js";
import { createStridePool } from "../persistence/mysql.js";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(day: string): string {
  if (!DAY_RE.test(day)) {
    throw new Error(`invalid day (expected YYYY-MM-DD Shanghai calendar day): ${day}`);
  }
  return day;
}
export class MySqlDataProvider implements DataProvider {
  private readonly ownsPool: boolean;

  /**
   * Wrap an existing pool (inject for tests / reuse), or use {@link MySqlDataProvider.create}
   * to open a self-owned pool against the local `stride` DB.
   */
  constructor(
    private readonly pool: Pool,
    options: { ownsPool?: boolean } = {},
  ) {
    this.ownsPool = options.ownsPool ?? false;
  }

  /**
   * Open a connection pool to the local `stride` MySQL DB and return a store.
   * `config` comes from the API-owned `loadApiConfig().strideDatabase`.
   */
  static create(config: MySqlConfig): MySqlDataProvider {
    return new MySqlDataProvider(createStridePool(config), { ownsPool: true });
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

  async getMasterPlanMetadataForDate(userId: string, day: string): Promise<ActiveMasterPlanMetadata | null> {
    assertDay(day);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT plan_id, revision, status, content
	         FROM master_plan
	        WHERE user_id = ?
	          AND content_version = 2
	          AND status IN ('active', 'archived')`,
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
    if (matches.length > 1) {
      throw new Error(`multiple master plans cover ${day} for ${userId}`);
    }
    return matches[0] ?? null;
  }

  /**
   * All activities a user recorded within an inclusive Asia/Shanghai
   * calendar-day range `[startDay, endDay]`, earliest first. Both bounds are
   * `YYYY-MM-DD` Shanghai dates; `userId` is the JWT-`sub` UUID. A single day is
   * `startDay === endDay`.
   */
  async getActivitiesByDateRange(userId: string, startDay: string, endDay: string): Promise<Activity[]> {
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
              a.feel, a.vertical_oscillation_mm, a.ground_contact_time_ms,
              a.vertical_ratio_pct, a.pauses, a.provider
         FROM activities a
         LEFT JOIN activity_training_load t
           ON t.user_id = a.user_id AND t.label_id = a.label_id
        WHERE a.user_id = ? AND DATE(a.date + INTERVAL 8 HOUR) BETWEEN ? AND ?
        ORDER BY a.date ASC`,
      [userId, startDay, endDay],
    );
    return rows.map(rowToActivity);
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
   * “比赛级别”的跑步努力，最近在前。数据没有显式比赛标记，故以「距离 ≥
   * `minDistanceKm`（默认 20km，即半马及以上）的跑步」作为比赛候选，带上配速、心率、
   * `feel` 供上层判断是否“跑崩”。生成赛季计划前用它回看运动员的历史比赛表现。
   */
  async getRaceHistory(userId: string, options: { asOfDate: string; minDistanceKm?: number; limit?: number }): Promise<RaceEffort[]> {
    assertDay(options.asOfDate);
    const minDistanceM = Math.round((options.minDistanceKm ?? 20) * 1000);
    const limit = Math.min(Math.max(options.limit ?? 15, 1), 100);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT DATE(date + INTERVAL 8 HOUR) AS sh_day, label_id, name, sport,
              distance_m, duration_s, avg_pace_s_km, avg_hr, max_hr, feel
         FROM activities
	       WHERE user_id = ?
	         AND sport LIKE 'run%'
	         AND distance_m >= ?
	         AND DATE(date + INTERVAL 8 HOUR) <= ?
	       ORDER BY date DESC
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

  /** Latest canonical running calibration on or before the inclusive cutoff. */
  async getLatestRunningCalibration(userId: string, asOfDate: string): Promise<RunningCalibration | null> {
    const [snapshotRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, as_of_date, threshold_hr, threshold_speed_mps, rhr_baseline,
              threshold_hr_confidence, threshold_speed_confidence
         FROM running_calibration_snapshot
	       WHERE user_id = ? AND as_of_date <= ?
        ORDER BY as_of_date DESC, algorithm_version DESC
        LIMIT 1`,
      [userId, asOfDate],
    );
    const snapshot = snapshotRows[0];
    if (!snapshot) {
      return null;
    }

    const [paceRows, heartRateRows] = await Promise.all([
      this.pool.query<RowDataPacket[]>(
        `SELECT name, min_pace_s_per_km, max_pace_s_per_km
           FROM running_calibration_pace_zone
          WHERE user_id = ? AND snapshot_id = ?
          ORDER BY name ASC`,
        [userId, snapshot.id],
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT name, min_bpm, max_bpm
           FROM running_calibration_hr_zone
          WHERE user_id = ? AND snapshot_id = ?
          ORDER BY name ASC`,
        [userId, snapshot.id],
      ),
    ]);

    return {
      asOfDate: snapshot.as_of_date as string,
      thresholdHr: (snapshot.threshold_hr ?? null) as number | null,
      thresholdSpeedMps: (snapshot.threshold_speed_mps ?? null) as number | null,
      rhrBaseline: (snapshot.rhr_baseline ?? null) as number | null,
      thresholdHrConfidence: snapshot.threshold_hr_confidence as string,
      thresholdSpeedConfidence: snapshot.threshold_speed_confidence as string,
      paceZones: paceRows[0].map(rowToPaceZone),
      heartRateZones: heartRateRows[0].map(rowToHeartRateZone),
    };
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

function rowToActivity(row: RowDataPacket): Activity {
  return {
    userId: row.user_id as string,
    labelId: row.label_id as string,
    name: (row.name ?? null) as string | null,
    sportName: (row.sport_name ?? null) as string | null,
    date: row.date as Date,
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
    feel: (row.feel ?? null) as string | null,
    verticalOscillationMm: (row.vertical_oscillation_mm ?? null) as number | null,
    groundContactTimeMs: (row.ground_contact_time_ms ?? null) as number | null,
    verticalRatioPct: (row.vertical_ratio_pct ?? null) as number | null,
    pauses: (row.pauses ?? null) as unknown | null,
    provider: row.provider as string,
  };
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
