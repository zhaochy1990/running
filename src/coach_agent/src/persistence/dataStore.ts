/**
 * Read access to the shared `stride` MySQL database — the multi-user store of
 * watch-synced training data (activities, laps, daily health, …).
 *
 * This is deliberately separate from the coach-agent checkpointer/store (which
 * live in the `coach_agent` DB): `StrideDataStore` only *reads* the activity
 * data that the Go sync worker owns.
 *
 * Timezone note (HARD, see AGENTS.md): `activities.date` is stored as **UTC**,
 * but a user-facing "day" is an **Asia/Shanghai (UTC+8, no DST)** calendar day.
 * Day filtering therefore compares `DATE(date + INTERVAL 8 HOUR)` — the MySQL
 * mirror of the canonical `SHANGHAI_DAY_SQL` (`date(datetime(date,'+8 hours'))`).
 */

import type { Pool, RowDataPacket } from "mysql2/promise";
import { createStridePool, type MySqlConfig } from "./mysql.js";

/**
 * One row of the `activities` table, camelCased. `date` is a UTC instant (the
 * pool is pinned to `timezone: "Z"`). JSON columns are returned already parsed
 * by mysql2.
 */
export interface Activity {
	userId: string;
	labelId: string;
	name: string | null;
	sportName: string | null;
	date: Date;
	distanceM: number | null;
	durationS: number | null;
	avgPaceSKm: number | null;
	adjustedPace: number | null;
	bestKmPace: number | null;
	maxPace: number | null;
	avgHr: number | null;
	maxHr: number | null;
	avgCadence: number | null;
	maxCadence: number | null;
	avgPower: number | null;
	maxPower: number | null;
	avgStepLenCm: number | null;
	ascentM: number | null;
	descentM: number | null;
	caloriesKcal: number | null;
	aerobicEffect: number | null;
	anaerobicEffect: number | null;
	/** COROS 手表原生的训练负荷值（`activities.training_load`）。 */
	trainingLoad: number | null;
	/**
	 * STRIDE 自算的单次训练负荷（`activity_training_load.training_dose`），
	 * TSS-scaled（1h 阈值 ≈ 100）。来自 LEFT JOIN，未算出时为 null。
	 */
	strideDose: number | null;
	vo2max: number | null;
	temperature: number | null;
	humidity: number | null;
	feelsLike: number | null;
	windSpeed: number | null;
	sportNote: string | null;
	sport: string | null;
	trainKind: string | null;
	feel: string | null;
	verticalOscillationMm: number | null;
	groundContactTimeMs: number | null;
	verticalRatioPct: number | null;
	pauses: unknown | null;
	provider: string;
}

/**
 * One row of `daily_training_load` — STRIDE 的每日训练负荷汇总（PMC）。
 * `date` 是 Asia/Shanghai 日历日 `YYYY-MM-DD`（该表直接以本地日为主键，无需时区换算）。
 */
export interface DailyTrainingLoad {
	/** Asia/Shanghai 日历日 `YYYY-MM-DD`。 */
	date: string;
	/** 当日 STRIDE 训练剂量（TSS-scaled，1h 阈值 ≈ 100）。 */
	trainingDose: number;
	/** 短期负荷 / acute（ATL，约 7 天指数加权）。 */
	acuteLoad: number | null;
	/** 长期负荷 / chronic（CTL，约 42 天指数加权）。 */
	chronicLoad: number | null;
	/** form = chronic − acute（正=更休息/更 fresh，负=更疲劳）。 */
	form: number | null;
	/** 负荷比 = acute / chronic。 */
	loadRatio: number | null;
	/** 就绪度信号灯：green / yellow / red。 */
	readinessGate: string | null;
	/** 数据覆盖状态（complete / rest_confirmed / unknown …）。 */
	coverageStatus: string;
}

/**
 * 一次“比赛级别”的跑步努力 —— 供教练回看运动员的比赛/长距离表现。
 * 数据里没有显式的“比赛”标记，因此这里以「较长距离的跑步」作为比赛候选，
 * 由上层结合 `feel`、配速与 PB 判断是否真是比赛、是否“跑崩”。
 */
export interface RaceEffort {
	/** Asia/Shanghai 日历日 `YYYY-MM-DD`。 */
	date: string;
	labelId: string;
	name: string | null;
	sport: string | null;
	distanceKm: number | null;
	durationMin: number | null;
	/** 平均配速，秒/公里。 */
	avgPaceSKm: number | null;
	avgHr: number | null;
	maxHr: number | null;
	/** 手表同步的数值主观感受评分。 */
	feel: number | null;
}

/** 某个标准距离上的个人最好成绩（`personal_bests`），作为“这次本该多快”的参照。 */
export interface PersonalBest {
	/** 距离标签，如 `5K` / `10K` / `HM` / `FM`。 */
	distance: string;
	/** PB 用时，秒。 */
	timeSec: number;
	/** 取得日期 `YYYY-MM-DD`（可能为空）。 */
	achievedAt: string | null;
	/** 来源：`activity` / `segment` 等。 */
	source: string | null;
}

/** Latest running calibration and its derived training zones. */
export interface RunningCalibration {
	asOfDate: string;
	thresholdHr: number | null;
	thresholdSpeedMps: number | null;
	thresholdHrConfidence: string;
	thresholdSpeedConfidence: string;
	heartRateZones: HeartRateZone[];
	paceZones: PaceZone[];
}

export interface HeartRateZone {
	name: string;
	minBpm: number | null;
	maxBpm: number | null;
}

export interface PaceZone {
	name: string;
	minPaceSPerKm: number | null;
	maxPaceSPerKm: number | null;
}

export interface UserProfile {
	userId: string;
	displayName: string | null;
	dob: string | null;
	sex: string | null;
	heightCm: number | null;
	weightKg: number | null;
	runningAgeRange: string | null;
}
export interface UserInjury {
	description: string;
	recoveryStatus: string;
	runningRestriction: string;
}
export interface DailyRecovery {
	date: string;
	rhr: number | null;
	hrv: number | null;
}
export interface ActiveMasterPlanMetadata {
	planId: string;
	revision: number;
	status: string;
	content: MasterPlanDocument;
}

/** Active structured master-plan document stored in `master_plan.content`. */
export type MasterPlanDocument = Record<string, unknown>;

/** Active structured weekly-plan document stored in `weekly_plan.content`. */
export type WeeklyPlanDocument = Record<string, unknown>;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(day: string): string {
	if (!DAY_RE.test(day)) {
		throw new Error(
			`invalid day (expected YYYY-MM-DD Shanghai calendar day): ${day}`,
		);
	}
	return day;
}
export class StrideDataStore {
	private readonly ownsPool: boolean;

	/**
	 * Wrap an existing pool (inject for tests / reuse), or use {@link StrideDataStore.create}
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
	 * `config` typically comes from `readStrideMySqlConfig(coachConfig)`
	 * (config/config.ts), which reads the `data_store` block of the coach config.
	 */
	static create(config: MySqlConfig): StrideDataStore {
		return new StrideDataStore(createStridePool(config), { ownsPool: true });
	}

	async getUserProfile(userId: string): Promise<UserProfile | null> {
		const [rows] = await this.pool.query<RowDataPacket[]>(
			`SELECT user_id, display_name, dob, sex, height_cm, weight_kg, running_age_range FROM user_profile WHERE user_id = ? LIMIT 1`,
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

	async getDailyRecoveryByDateRange(
		userId: string,
		startDay: string,
		endDay: string,
	): Promise<DailyRecovery[]> {
		assertDay(startDay);
		assertDay(endDay);
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

	async getActiveMasterPlanMetadata(
		userId: string,
	): Promise<ActiveMasterPlanMetadata | null> {
		const [rows] = await this.pool.query<RowDataPacket[]>(
			`SELECT plan_id, revision, status, content FROM master_plan WHERE user_id = ? AND content_version = 2 AND status = 'active' LIMIT 1`,
			[userId],
		);
		const row = rows[0];
		return row
			? {
					planId: row.plan_id as string,
					revision: row.revision as number,
					status: row.status as string,
					content: parsePlanContent(row.content, "master_plan"),
				}
			: null;
	}

	/**
	 * All activities a user recorded within an inclusive Asia/Shanghai
	 * calendar-day range `[startDay, endDay]`, earliest first. Both bounds are
	 * `YYYY-MM-DD` Shanghai dates; `userId` is the JWT-`sub` UUID. A single day is
	 * `startDay === endDay`.
	 */
	async getActivitiesByDateRange(
		userId: string,
		startDay: string,
		endDay: string,
	): Promise<Activity[]> {
		assertDay(startDay);
		assertDay(endDay);
		if (startDay > endDay) {
			throw new Error(
				`startDay (${startDay}) must not be after endDay (${endDay})`,
			);
		}
		const [rows] = await this.pool.query<RowDataPacket[]>(
			`SELECT a.*, t.training_dose AS stride_dose
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
	async getDailyTrainingLoadByDateRange(
		userId: string,
		startDay: string,
		endDay: string,
	): Promise<DailyTrainingLoad[]> {
		assertDay(startDay);
		assertDay(endDay);
		if (startDay > endDay) {
			throw new Error(
				`startDay (${startDay}) must not be after endDay (${endDay})`,
			);
		}
		const [rows] = await this.pool.query<RowDataPacket[]>(
			`SELECT date, training_dose, acute_load, chronic_load, form, load_ratio,
              readiness_gate, coverage_status
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
	async getRaceHistory(
		userId: string,
		options: { minDistanceKm?: number; limit?: number } = {},
	): Promise<RaceEffort[]> {
		const minDistanceM = Math.round((options.minDistanceKm ?? 20) * 1000);
		const limit = Math.min(Math.max(options.limit ?? 15, 1), 100);
		const [rows] = await this.pool.query<RowDataPacket[]>(
			`SELECT DATE(date + INTERVAL 8 HOUR) AS sh_day, label_id, name, sport,
              distance_m, duration_s, avg_pace_s_km, avg_hr, max_hr, feel
         FROM activities
        WHERE user_id = ? AND sport LIKE 'run%' AND distance_m >= ?
        ORDER BY date DESC
        LIMIT ?`,
			[userId, minDistanceM, limit],
		);
		return rows.map(rowToRaceEffort);
	}

	/** 运动员各标准距离的个人最好成绩（`personal_bests`），作为比赛表现的参照系。 */
	async getPersonalBests(userId: string): Promise<PersonalBest[]> {
		const [rows] = await this.pool.query<RowDataPacket[]>(
			`SELECT distance, pb_time_sec, achieved_at, source
         FROM personal_bests
        WHERE user_id = ?
        ORDER BY pb_time_sec ASC`,
			[userId],
		);
		return rows.map((r) => ({
			distance: r.distance as string,
			timeSec: Math.round(Number(r.pb_time_sec) * 10) / 10,
			achievedAt: (r.achieved_at ?? null) as string | null,
			source: (r.source ?? null) as string | null,
		}));
	}

	/** Latest canonical running calibration and zones, or null when not computed. */
	async getLatestRunningCalibration(
		userId: string,
	): Promise<RunningCalibration | null> {
		const [snapshotRows] = await this.pool.query<RowDataPacket[]>(
			`SELECT id, as_of_date, threshold_hr, threshold_speed_mps,
              threshold_hr_confidence, threshold_speed_confidence
         FROM running_calibration_snapshot
        WHERE user_id = ?
        ORDER BY as_of_date DESC, algorithm_version DESC
        LIMIT 1`,
			[userId],
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
			thresholdSpeedMps: (snapshot.threshold_speed_mps ?? null) as
				| number
				| null,
			thresholdHrConfidence: snapshot.threshold_hr_confidence as string,
			thresholdSpeedConfidence: snapshot.threshold_speed_confidence as string,
			paceZones: paceRows[0].map(rowToPaceZone),
			heartRateZones: heartRateRows[0].map(rowToHeartRateZone),
		};
	}

	/** Current active structured season plan, or null when the athlete has none. */
	async getMasterPlan(userId: string): Promise<MasterPlanDocument | null> {
		const [rows] = await this.pool.query<RowDataPacket[]>(
			`SELECT content
         FROM master_plan
        WHERE user_id = ? AND content_version = 2 AND status = 'active'
        LIMIT 1`,
			[userId],
		);
		return rows.length === 0
			? null
			: parsePlanContent(rows[0]!.content, "master_plan");
	}

	/**
	 * Active structured weekly plan for `weekName` (`YYYY-MM-DD_MM-DD`), or null.
	 * MySQL stores the week start only, so the caller-facing week identity is
	 * reduced to its Monday date before querying.
	 */
	async getWeeklyPlan(
		userId: string,
		weekName: string,
	): Promise<WeeklyPlanDocument | null> {
		const weekStart = weekName.slice(0, 10);
		const [rows] = await this.pool.query<RowDataPacket[]>(
			`SELECT content
         FROM weekly_plan
        WHERE user_id = ? AND week_start = ? AND content_version = 2 AND status = 'active'
        LIMIT 1`,
			[userId, weekStart],
		);
		return rows.length === 0
			? null
			: parsePlanContent(rows[0]!.content, "weekly_plan");
	}

	/** Release the pool — only if this store opened it (via {@link StrideDataStore.create}). */
	async close(): Promise<void> {
		if (this.ownsPool) {
			await this.pool.end();
		}
	}
}

function normalizeDay(day: string): string {
	return day.length === 8
		? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`
		: day;
}

function parsePlanContent(
	content: unknown,
	table: string,
): Record<string, unknown> {
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
		adjustedPace: (row.adjusted_pace ?? null) as number | null,
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
		caloriesKcal: (row.calories_kcal ?? null) as number | null,
		aerobicEffect: (row.aerobic_effect ?? null) as number | null,
		anaerobicEffect: (row.anaerobic_effect ?? null) as number | null,
		trainingLoad: (row.training_load ?? null) as number | null,
		strideDose: (row.stride_dose ?? null) as number | null,
		vo2max: (row.vo2max ?? null) as number | null,
		temperature: (row.temperature ?? null) as number | null,
		humidity: (row.humidity ?? null) as number | null,
		feelsLike: (row.feels_like ?? null) as number | null,
		windSpeed: (row.wind_speed ?? null) as number | null,
		sportNote: (row.sport_note ?? null) as string | null,
		sport: (row.sport ?? null) as string | null,
		trainKind: (row.train_kind ?? null) as string | null,
		feel: (row.feel ?? null) as string | null,
		verticalOscillationMm: (row.vertical_oscillation_mm ?? null) as
			| number
			| null,
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
		readinessGate: (row.readiness_gate ?? null) as string | null,
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
