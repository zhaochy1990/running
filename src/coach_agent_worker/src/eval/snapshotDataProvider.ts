import type {
  ActiveMasterPlanMetadata,
  Activity,
  DailyRecovery,
  DailyTrainingLoad,
  DataProvider,
  PersonalBest,
  RaceCalendarSearchQuery,
  RaceEffort,
  RaceTarget,
  RunningCalibration,
  SyncCoverage,
  SyncRecentAnalysis,
  UserInjury,
  UserProfile,
} from "@stride/coach-agent";
import { type RunnerSnapshot, RunnerSnapshotSchema } from "@stride/coach-agent";
import { shanghaiDay } from "@stride/contract";

/**
 * 只读快照 Provider（devops#1047/#1055）：把一份冻结的 RunnerSnapshot 装配成 Coach Agent
 * 的 `DataProvider`。被测版本自己的 `DataProviderMasterPlanContextProvider` 照常经它取数，
 * 所以上下文装配层的变化也能被测评到；测评容器不装配生产 MySQL、Go API 客户端或写工具。
 *
 * 两种“没有”严格区分（#1047）：覆盖范围内确实无记录 → 空数组 / null；请求落在快照
 * 覆盖之外（晚于数据截止日）或调用了快照不含的读面 → 抛 `SnapshotNotCoveredError`，
 * 绝不回退线上。
 */
export class SnapshotNotCoveredError extends Error {
  readonly code = "snapshot_not_covered";
  constructor(
    readonly method: string,
    detail: string,
  ) {
    super(`${method}: ${detail}`);
    this.name = "SnapshotNotCoveredError";
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function toSyncCoverage(coverage: RunnerSnapshot["records"]["sync_coverage"]): SyncCoverage | null {
  if (coverage === null) return null;
  const detail = coverage.recentAnalysisDetail;
  return {
    ...compact(coverage),
    updatedAt: new Date(coverage.updatedAt),
    recentAnalysisDetail: detail ? ({ ...compact(detail), computedAt: new Date(detail.computedAt) } as SyncRecentAnalysis) : null,
  } as SyncCoverage;
}

/** 与 MySqlDataProvider 的 masterPlanContainsDay 同口径：优先顶层起止日，否则逐阶段判断。 */
function planCoversDay(content: Record<string, unknown>, day: string): boolean {
  const start = typeof content.start_date === "string" ? content.start_date : null;
  const end = typeof content.end_date === "string" ? content.end_date : null;
  if (start !== null && end !== null) return start <= day && day <= end;
  return (
    Array.isArray(content.phases) &&
    content.phases.some(
      (phase) =>
        typeof phase === "object" &&
        phase !== null &&
        typeof (phase as Record<string, unknown>).start_date === "string" &&
        planCoversDay(phase as Record<string, unknown>, day),
    )
  );
}

/** JSON 往返会把缺省的可选键变成显式 undefined；域类型在 exactOptionalPropertyTypes 下不接受。 */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function assertDay(day: string): string {
  if (!DAY.test(day)) throw new Error(`invalid day (expected YYYY-MM-DD Shanghai calendar day): ${day}`);
  return day;
}

export class SnapshotDataProvider implements DataProvider {
  constructor(
    private readonly snapshot: RunnerSnapshot,
    private readonly userId: string,
    private readonly asOf: string,
    private readonly onNotCovered: (error: SnapshotNotCoveredError) => void = () => undefined,
  ) {}

  /** 从领取到的冻结输入装配；结构不合法即视为“执行输入不兼容”。 */
  static parse(raw: unknown): RunnerSnapshot {
    return RunnerSnapshotSchema.parse(raw);
  }

  private assertUser(userId: string, method: string): void {
    if (userId !== this.userId) this.notCovered(method, `user ${userId} is not the snapshot runner`);
  }

  private notCovered(method: string, detail: string): never {
    const error = new SnapshotNotCoveredError(method, detail);
    this.onNotCovered(error);
    throw error;
  }

  /** 截止日之后的范围快照里没有数据——不能拿“空”冒充“没有记录”。 */
  private assertRange(method: string, startDay: string, endDay: string): void {
    assertDay(startDay);
    assertDay(endDay);
    if (startDay > endDay) throw new Error(`startDay (${startDay}) must not be after endDay (${endDay})`);
    if (endDay > this.snapshot.as_of_day) {
      this.notCovered(method, `${startDay}..${endDay} is beyond the snapshot cutoff ${this.snapshot.as_of_day}`);
    }
  }

  private assertAsOf(method: string, asOfDate: string): void {
    assertDay(asOfDate);
    if (asOfDate > this.snapshot.as_of_day) {
      this.notCovered(method, `as-of ${asOfDate} is beyond the snapshot cutoff ${this.snapshot.as_of_day}`);
    }
  }

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    this.assertUser(userId, "getUserProfile");
    return this.snapshot.records.profile;
  }

  async getUserInjuries(userId: string): Promise<UserInjury[]> {
    this.assertUser(userId, "getUserInjuries");
    return this.snapshot.records.injuries;
  }

  async getDailyRecoveryByDateRange(userId: string, startDay: string, endDay: string): Promise<DailyRecovery[]> {
    this.assertUser(userId, "getDailyRecoveryByDateRange");
    this.assertRange("getDailyRecoveryByDateRange", startDay, endDay);
    const rows = this.snapshot.records.daily_recovery.filter((row) => row.date >= startDay && row.date <= endDay);
    for (const row of rows) this.assertKnownDay("getDailyRecoveryByDateRange", row.date);
    return rows;
  }

  async getActivitySummariesByDateRange(userId: string, startDay: string, endDay: string): Promise<Activity[]> {
    this.assertUser(userId, "getActivitySummariesByDateRange");
    this.assertRange("getActivitySummariesByDateRange", startDay, endDay);
    return this.activities(startDay, endDay).map((activity) => ({ ...activity, laps: [] }));
  }

  async getManualStrengthSummaries() {
    return this.notCovered("getManualStrengthSummaries", "manual strength reviews are not included in plan evaluation snapshots");
  }

  async getManualStrengthDetail() {
    return this.notCovered("getManualStrengthDetail", "manual strength reviews are not included in plan evaluation snapshots");
  }

  async getActivitiesByDateRange(userId: string, startDay: string, endDay: string): Promise<Activity[]> {
    this.assertUser(userId, "getActivitiesByDateRange");
    this.assertRange("getActivitiesByDateRange", startDay, endDay);
    return this.activities(startDay, endDay);
  }

  async getDailyTrainingLoadByDateRange(userId: string, startDay: string, endDay: string): Promise<DailyTrainingLoad[]> {
    this.assertUser(userId, "getDailyTrainingLoadByDateRange");
    this.assertRange("getDailyTrainingLoadByDateRange", startDay, endDay);
    const rows = this.snapshot.records.daily_training_load.filter((row) => row.date >= startDay && row.date <= endDay);
    for (const row of rows) this.assertKnownDay("getDailyTrainingLoadByDateRange", row.date);
    return rows;
  }

  async getRaceHistory(userId: string, options: { asOfDate: string; minDistanceKm?: number; limit?: number }): Promise<RaceEffort[]> {
    this.assertUser(userId, "getRaceHistory");
    this.assertAsOf("getRaceHistory", options.asOfDate);
    const minDistanceM = Math.round((options.minDistanceKm ?? 4.5) * 1000);
    const limit = Math.min(Math.max(options.limit ?? 15, 1), 100);
    const rows = this.snapshot.records.race_history
      .filter((effort) => effort.date <= options.asOfDate && (effort.distanceKm ?? 0) * 1000 >= minDistanceM)
      .slice(0, limit);
    for (const row of rows) this.assertKnownDay("getRaceHistory", row.date);
    return rows;
  }

  async getPersonalBests(userId: string, asOfDate: string): Promise<PersonalBest[]> {
    this.assertUser(userId, "getPersonalBests");
    this.assertAsOf("getPersonalBests", asOfDate);
    const rows = this.snapshot.records.personal_bests.filter((best) => (best.achievedAt ?? "") <= asOfDate);
    for (const row of rows) if (row.achievedAt !== null) this.assertKnownDay("getPersonalBests", row.achievedAt);
    return rows;
  }

  /** 快照只冻结了截止日那一次读取得到的校准；问更早的截止日时它若尚未生效则为 null。 */
  async getLatestRunningCalibration(userId: string, asOfDate: string): Promise<RunningCalibration | null> {
    this.assertUser(userId, "getLatestRunningCalibration");
    const day = DAY.test(asOfDate) ? asOfDate : shanghaiDay(asOfDate);
    this.assertAsOf("getLatestRunningCalibration", day);
    const calibration = this.snapshot.records.running_calibration;
    if (calibration !== null && calibration.asOfDate <= day) {
      this.assertKnownDay("getLatestRunningCalibration", calibration.asOfDate);
      return compact(calibration) as RunningCalibration;
    }
    return null;
  }

  /**
   * 覆盖某一天的赛季计划。不设截止日守卫：生产上下文装配本来就会问「下周一」被哪份
   * 计划覆盖，答案由冻结计划自己的起止日期决定（与 MySQL 读面的 containsDay 过滤同口径）。
   */
  async getMasterPlanMetadataForDate(userId: string, day: string): Promise<ActiveMasterPlanMetadata | null> {
    this.assertUser(userId, "getMasterPlanMetadataForDate");
    assertDay(day);
    const plan = this.snapshot.records.active_master_plan;
    return plan !== null && planCoversDay(plan.content, day) ? plan : null;
  }

  async getMasterPlan(userId: string, day: string) {
    return (await this.getMasterPlanMetadataForDate(userId, day))?.content ?? null;
  }

  async getRaceTarget(userId: string): Promise<RaceTarget | null> {
    this.assertUser(userId, "getRaceTarget");
    return this.snapshot.records.race_target;
  }

  async getSyncCoverage(userId: string): Promise<SyncCoverage | null> {
    this.assertUser(userId, "getSyncCoverage");
    const coverage = this.snapshot.records.sync_coverage;
    if (coverage === null) return null;
    // JSON 形状与域类型逐字段对应，只差 Date 与 readiness 字面量类型。
    return toSyncCoverage(coverage);
  }

  // ── v1 快照不含的读面：显式报“快照未覆盖”，不得回退线上 ──
  async getVendorHrvBaseline(_userId: string, asOfDay: string): Promise<never> {
    this.notCovered("getVendorHrvBaseline", `as of ${asOfDay}`);
  }
  async getWeeklyFeedbackByDateRange(_userId: string, startDay: string, endDay: string): Promise<never> {
    this.notCovered("getWeeklyFeedbackByDateRange", `${startDay}..${endDay}`);
  }
  /** 快照冻结的是区间读面（含 laps）；公里分段来自 Go API，快照未覆盖。 */
  async getActivityDetail(userId: string, labelId: string): Promise<Activity | null> {
    this.assertUser(userId, "getActivityDetail");
    return this.activities("1900-01-01", this.snapshot.as_of_day).find((activity) => activity.labelId === labelId) ?? null;
  }
  async getWeeklyPlan(userId: string, weekName: string): Promise<Record<string, unknown> | null> {
    this.assertUser(userId, "getWeeklyPlan");
    const docs = this.snapshot.records.weekly_plans;
    if (docs === undefined) this.notCovered("getWeeklyPlan", "records.weekly_plans is missing");
    return docs.find((row) => row.week_start === weekName || row.content.week_name === weekName)?.content ?? null;
  }

  async listWeeklyPlanWeeks(userId: string, masterPlanId: string) {
    this.assertUser(userId, "listWeeklyPlanWeeks");
    const rows = this.snapshot.records.weekly_plan_weeks;
    if (rows === undefined) this.notCovered("listWeeklyPlanWeeks", "records.weekly_plan_weeks is missing");
    return rows.filter((row) => row.master_plan_id === masterPlanId);
  }
  async getPlanSessions(_userId: string, dateFrom: string, dateTo: string): Promise<never> {
    this.notCovered("getPlanSessions", `${dateFrom}..${dateTo}`);
  }
  async getRaceCalendarContext(raceEventId: number): Promise<never> {
    this.notCovered("getRaceCalendarContext", `race event ${raceEventId}`);
  }
  async searchRaceCalendar(_options: RaceCalendarSearchQuery): Promise<never> {
    this.notCovered("searchRaceCalendar", "race calendar");
  }
  async getPerformanceBaseline(_userId: string, asOfDate: string): Promise<never> {
    this.notCovered("getPerformanceBaseline", `as of ${asOfDate}`);
  }

  private assertKnownDay(method: string, day: string): void {
    if (day === shanghaiDay(this.asOf) && this.snapshot.as_of === undefined && Date.parse(this.asOf) < Date.parse(`${day}T23:59:59+08:00`)) {
      this.notCovered(method, `${day} has day-level data only; snapshot.as_of is required for an intraday execution`);
    }
  }

  private activities(startDay: string, endDay: string): Activity[] {
    return this.snapshot.records.activities
      .filter((row) => row.shanghaiDay >= startDay && row.shanghaiDay <= endDay)
      .filter((row) => {
        if (Date.parse(row.date) > Date.parse(this.asOf)) return false;
        if (row.durationS === null) {
          this.assertKnownDay("getActivitiesByDateRange", row.shanghaiDay);
          return Date.parse(row.date) <= Date.parse(this.asOf);
        }
        return Date.parse(row.date) + row.durationS * 1000 <= Date.parse(this.asOf);
      })
      .map((row) => ({ ...row, userId: this.userId, date: new Date(row.date) }));
  }
}
