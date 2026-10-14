/// Centralized route path constants — mirrors the miniprogram IA
/// (训练 / 记录 / 教练 / 我 four tabs), decided in stride-devops#414.
class Routes {
  Routes._();

  // Auth
  static const authStart = '/auth/start';
  static const authLogin = '/auth/login';
  static const authRegister = '/auth/register';

  // 法务声明（公开可读，登录页协议链接的落地页）
  static const declarationPattern = '/declaration/:docType';
  static String declaration(String docType) => '/declaration/$docType';

  /// 未登录也可访问的页面集合（auth 流程页 + 法务声明页）。
  /// 集中在这里以便测试钉住，防止 redirect 重构时无声扩大或收回。
  static bool isPublicPath(String loc) =>
      loc.startsWith('/auth') || loc.startsWith('/declaration');

  // Onboarding — 单页三步状态机（资料→绑表→同步，stride-devops#461）。
  // 旧的五屏（brand/coros/sync/basic-info/blocked）已整体替换。
  static const onboarding = '/onboarding';

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
    if (rest.startsWith('/auth/')) {
      return '/auth${rest.substring('/auth'.length)}';
    }
    // 旧五屏深链整体归到单页 onboarding（页面会重算落点）。
    if (rest.startsWith('/onboarding')) return onboarding;

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
