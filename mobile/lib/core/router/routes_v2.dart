/// Centralized v2 route path constants.
///
/// All new (M1) routes use the `/v2/` prefix to coexist with the legacy
/// router during the migration.
class RoutesV2 {
  RoutesV2._();

  // Auth
  static const authStart = '/v2/auth/start';
  static const authLogin = '/v2/auth/login';
  static const authRegister = '/v2/auth/register';

  // Onboarding
  static const onboardingBrand = '/v2/onboarding/brand';
  static const onboardingCoros = '/v2/onboarding/coros';
  static const onboardingSync = '/v2/onboarding/sync';
  static const onboardingBasicInfo = '/v2/onboarding/basic-info';
  static const onboardingBlocked = '/v2/onboarding/blocked';

  // Main tabs (inside shell) — 4 flat tabs: 跑者 / 发现 / 数据 / 教练
  static const home = '/v2/home';
  static const discover = '/v2/discover';
  static const data = '/v2/data';
  static const coach = '/v2/coach';

  // Non-tab destinations (pushable, no longer in the bottom bar)
  static const train = '/v2/train'; // 周计划列表（从「跑者」进入）
  static const me = '/v2/me'; // 个人中心全页（≡ 抽屉「账号资料」）

  // Detail
  static const activityDetailPattern = '/v2/activity/:id';
  static String activityDetail(String id) => '/v2/activity/$id';

  // D6 — Pre-training screen
  static const preTrainingPattern = '/v2/plan/:date/:sessionIndex/pre';
  static String preTraining(String date, int sessionIndex) =>
      '/v2/plan/$date/$sessionIndex/pre';

  // D7 — Post-activity feedback (full-screen, no shell)
  static const feedbackPattern = '/v2/feedback/:labelId';
  static String feedback(String labelId) => '/v2/feedback/$labelId';

  // D9 — Weekly review (full-screen, no shell)
  static const reviewPattern = '/v2/review/:folder';
  static String review(String folder) => '/v2/review/$folder';

  // D2a — Week list (inside shell, replaces /v2/train placeholder)
  // No separate path constant needed — reuses [train] as the tab root.

  // D2 — Week detail (full-screen, no shell)
  static const weekDetailPattern = '/v2/plan/weeks/:folder';
  static String weekDetail(String folder) => '/v2/plan/weeks/$folder';

  // D3 — Session detail (full-screen, no shell)
  static const sessionDetailPattern =
      '/v2/plan/weeks/:folder/sessions/:date/:sessionIndex';
  static String sessionDetail(String folder, String date, int sessionIndex) =>
      '/v2/plan/weeks/$folder/sessions/$date/$sessionIndex';

  // D4 — Plan chat / adjust (full-screen, no shell)
  static const planChatPattern = '/v2/plan/weeks/:folder/chat';
  static String planChat(String folder) => '/v2/plan/weeks/$folder/chat';

  // D1 — Generate week (full-screen, no shell)
  // Query param: week_start=YYYY-MM-DD
  static const generatePattern = '/v2/plan/generate';
  static String generate(String weekStart) =>
      '/v2/plan/generate?week_start=$weekStart';

  // C1 — Training goal (fullscreen, no shell)
  static const trainingPlanGoal = '/v2/training-plan/goal';

  // C2 — Running profile (fullscreen, no shell)
  static const trainingPlanProfile = '/v2/training-plan/profile';

  // C3 — 3-year history sync (fullscreen, no shell, no back)
  static const trainingPlanHistorySync = '/v2/training-plan/history-sync';

  // C4 — Master plan generation (fullscreen, no shell)
  static const trainingPlanGenerate = '/v2/training-plan/generate';

  // C5 — Master plan review chat (fullscreen, no shell)
  static const trainingPlanReviewPattern = '/v2/training-plan/review/:planId';
  static String trainingPlanReview(String planId) =>
      '/v2/training-plan/review/$planId';

  // C6 — Master plan view (fullscreen, no shell)
  static const trainingPlanView = '/v2/training-plan/view';

  // C7 — Master plan adjust chat (fullscreen, no shell)
  static const trainingPlanAdjustPattern = '/v2/training-plan/adjust/:planId';
  static String trainingPlanAdjust(String planId) =>
      '/v2/training-plan/adjust/$planId';

  // C8 — Master plan adjustment history (fullscreen, no shell)
  static const trainingPlanHistoryPattern = '/v2/training-plan/history/:planId';
  static String trainingPlanHistory(String planId) =>
      '/v2/training-plan/history/$planId';

  // C8 — Master plan version snapshot (fullscreen, no shell)
  static const trainingPlanVersionPattern =
      '/v2/training-plan/version/:planId/:version';
  static String trainingPlanVersion(String planId, int version) =>
      '/v2/training-plan/version/$planId/$version';

  // E2 — PMC training load (fullscreen, no shell)
  static const dataPmc = '/v2/data/pmc';

  // E3 — Health trends detail (fullscreen, no shell)
  static const dataTrends = '/v2/data/trends';

  // E4 — Ability radar (fullscreen, no shell)
  static const abilityRadar = '/v2/data/ability';

  // E5 — Race predictions (fullscreen, no shell)
  static const predictions = '/v2/data/predictions';

  // E6 — PB records (fullscreen, no shell)
  static const pbRecords = '/v2/data/pbs';

  // M5 — Nutrition
  static const nutritionPrefs = '/v2/nutrition/prefs';
  static const nutritionDaily = '/v2/nutrition/daily';
  static const nutritionMeals = '/v2/nutrition/meals';
}
