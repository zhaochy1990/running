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

  // Main tabs (inside shell)
  static const home = '/v2/home';
  static const train = '/v2/train';
  static const data = '/v2/data';
  static const me = '/v2/me';

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
}
