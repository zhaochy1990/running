/** Read-only athlete data needed by the Coach Agent. */
export interface DataProvider {
	getUserProfile(userId: string): Promise<UserProfile | null>;
	getUserInjuries(userId: string): Promise<UserInjury[]>;
	getVendorHrvBaseline(
		userId: string,
		asOfDay: string,
	): Promise<VendorHrvBaseline | null>;
	getDailyRecoveryByDateRange(
		userId: string,
		startDay: string,
		endDay: string,
	): Promise<DailyRecovery[]>;
	getWeeklyFeedbackByDateRange(
		userId: string,
		startDay: string,
		endDay: string,
	): Promise<WeeklyFeedback[]>;
	getMasterPlanMetadataForDate(
		userId: string,
		day: string,
	): Promise<ActiveMasterPlanMetadata | null>;
	getActivitiesByDateRange(
		userId: string,
		startDay: string,
		endDay: string,
	): Promise<Activity[]>;
	getDailyTrainingLoadByDateRange(
		userId: string,
		startDay: string,
		endDay: string,
	): Promise<DailyTrainingLoad[]>;
	getRaceHistory(
		userId: string,
		options: { asOfDate: string; minDistanceKm?: number; limit?: number },
	): Promise<RaceEffort[]>;
	getPersonalBests(userId: string, asOfDate: string): Promise<PersonalBest[]>;
	getLatestRunningCalibration(
		userId: string,
		asOfDate: string,
	): Promise<RunningCalibration | null>;
	getMasterPlan(
		userId: string,
		day: string,
	): Promise<MasterPlanDocument | null>;
	getWeeklyPlan(
		userId: string,
		weekName: string,
	): Promise<WeeklyPlanDocument | null>;
	getRaceTarget(userId: string): Promise<RaceTarget | null>;
}

/** One watch-synced activity. `date` is a UTC instant. */
export interface Activity {
	userId: string;
	labelId: string;
	name: string | null;
	sportName: string | null;
	date: Date;
	distanceM: number | null;
	durationS: number | null;
	avgPaceSKm: number | null;
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
	strideSessionClass: string | null;
	temperature: number | null;
	humidity: number | null;
	feelsLike: number | null;
	windSpeed: number | null;
	sportNote: string | null;
	sport: string | null;
	feel: string | null;
	verticalOscillationMm: number | null;
	groundContactTimeMs: number | null;
	verticalRatioPct: number | null;
	pauses: unknown | null;
	provider: string;
}

export interface DailyTrainingLoad {
	date: string;
	trainingDose: number;
	acuteLoad: number | null;
	chronicLoad: number | null;
	form: number | null;
	loadRatio: number | null;
	coverageStatus: string;
}
export interface RaceEffort {
	date: string;
	labelId: string;
	name: string | null;
	sport: string | null;
	distanceKm: number | null;
	durationMin: number | null;
	avgPaceSKm: number | null;
	avgHr: number | null;
	maxHr: number | null;
	feel: number | null;
}
export interface PersonalBest {
	distance: string;
	timeSec: number;
	achievedAt: string | null;
	activityLabelId: string;
}
export interface RunningCalibration {
	asOfDate: string;
	thresholdHr: number | null;
	thresholdSpeedMps: number | null;
	rhrBaseline: number | null;
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
export interface VendorHrvBaseline {
	low: number | null;
	high: number | null;
	provider: string;
	date: string;
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
export interface WeeklyFeedback {
	weekStart: string;
	contentMd: string;
	updatedAt: Date;
}
export interface RaceTarget {
	goal_id: string;
	user_id: string;
	status: string;
	race_date: string;
	race_distance: string;
	race_name: string;
	target_finish_time: string;
	weekly_training_days: number;
}
export interface ActiveMasterPlanMetadata {
	planId: string;
	revision: number;
	status: string;
	content: MasterPlanDocument;
}
export type MasterPlanDocument = Record<string, unknown>;
export type WeeklyPlanDocument = Record<string, unknown>;
