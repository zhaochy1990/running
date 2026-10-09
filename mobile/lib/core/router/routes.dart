/// Centralized route path constants — mirrors the miniprogram IA
/// (训练 / 记录 / 教练 / 我 four tabs), decided in stride-devops#414.
class Routes {
  Routes._();

  // Auth
  static const authStart = '/auth/start';
  static const authLogin = '/auth/login';
  static const authRegister = '/auth/register';

  // Onboarding
  static const onboardingBrand = '/onboarding/brand';
  static const onboardingCoros = '/onboarding/coros';
  static const onboardingSync = '/onboarding/sync';
  static const onboardingBasicInfo = '/onboarding/basic-info';
  static const onboardingBlocked = '/onboarding/blocked';

  // Main tabs (inside shell) — 训练 / 记录 / 教练 / 我
  static const training = '/training';
  static const records = '/records';
  static const coach = '/coach';
  static const me = '/me';

  // Training — weekly plan (kept live subset of the old D-series)
  static const planWeeks = '/training/plan';
  static const weekDetailPattern = '/training/plan/weeks/:folder';
  static String weekDetail(String folder) => '/training/plan/weeks/$folder';

  static const sessionDetailPattern =
      '/training/plan/weeks/:folder/sessions/:date/:sessionIndex';
  static String sessionDetail(String folder, String date, int sessionIndex) =>
      '/training/plan/weeks/$folder/sessions/$date/$sessionIndex';

  // Records — activity list + detail
  static const activityDetailPattern = '/records/activity/:id';
  static String activityDetail(String id) => '/records/activity/$id';

  // Me — profile tab + second-level pages
  static const meData = '/me/data';
  static const meDataPmc = '/me/data/pmc';
  static const meDataTrends = '/me/data/trends';
  static const meDataAbility = '/me/data/ability';
  static const meDataPredictions = '/me/data/predictions';
  static const meDataPbs = '/me/data/pbs';
  static const meWatch = '/me/watch';

  /// Map a legacy `/v2/*` deep link to its new location (#414 redirect table).
  /// Returns null when [loc] is not legacy. Unmapped legacy domains (deleted
  /// features) fall back to /training.
  static String? redirectLegacy(String loc) {
    if (!loc.startsWith('/v2/')) return null;
    final rest = loc.substring('/v2'.length); // keeps leading '/'

    // Ordered: longest / most specific prefixes first.
    if (rest.startsWith('/data/')) {
      const dataPages = {
        '/data/pmc': meDataPmc,
        '/data/trends': meDataTrends,
        '/data/ability': meDataAbility,
        '/data/predictions': meDataPredictions,
        '/data/pbs': meDataPbs,
      };
      return dataPages[rest] ?? meData;
    }
    if (rest.startsWith('/activity/')) {
      return '/records/activity${rest.substring('/activity'.length)}';
    }
    // /plan/ 只放行存活的 weeks 子树；generate/chat/pre 等已删域兜底 /training。
    if (rest.startsWith('/plan/weeks/')) {
      return '$planWeeks${rest.substring('/plan'.length)}';
    }
    if (rest.startsWith('/plan')) return training;
    if (rest.startsWith('/train')) return planWeeks;
    if (rest.startsWith('/auth/')) return '/auth${rest.substring('/auth'.length)}';
    if (rest.startsWith('/onboarding/')) return '/onboarding${rest.substring('/onboarding'.length)}';

    const exact = {
      '/home': training,
      '/train': planWeeks,
      '/me': me,
      '/coach': coach,
      '/data': meData,
      '/discover': training, // deleted domain → fallback
    };
    return exact[rest] ?? training;
  }
}
