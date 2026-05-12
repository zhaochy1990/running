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
}
