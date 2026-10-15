/// Environment configuration for STRIDE mobile.
///
/// All values are baked at build time via `--dart-define`. Defaults match
/// production prod (the only environment v1 uses). For local dev against a
/// localhost backend, override via:
///
///     flutter run \
///       --dart-define=API_BASE_URL=http://10.0.2.2:8000 \
///       --dart-define=AUTH_URL=http://10.0.2.2:8001
abstract final class Env {
  /// STRIDE backend base URL — all `/api/*` calls.
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue:
        'https://api.stride-running.cn',
  );

  /// auth-service base URL — `/api/auth/login`, `/refresh`, `/logout`.
  static const String authUrl = String.fromEnvironment(
    'AUTH_URL',
    defaultValue:
        'https://api.stride-running.cn',
  );

  /// OAuth2 client_id for STRIDE app on the auth-service.
  static const String clientId = String.fromEnvironment(
    'CLIENT_ID',
    defaultValue: 'app_62978bf2803346878a2e4805',
  );

  /// Build flavor — defaults to "prod" for v1.
  static const String flavor = String.fromEnvironment(
    'FLAVOR',
    defaultValue: 'prod',
  );

  /// 高德 Android key（issue 463：公开可提交，参照 JPush AppKey 先例，
  /// 同时写死在 AndroidManifest meta-data com.amap.api.v2.apikey）。
  static const String amapAndroidKey = String.fromEnvironment(
    'AMAP_ANDROID_KEY',
    defaultValue: '03584266ce969aa39973e480b8436861',
  );

  /// 高德 iOS key（安全码=Bundle ID cn.striderunning.stride；公开可提交，
  /// 与 Android key 同口径）。覆盖经 --dart-define=AMAP_IOS_KEY 注入。
  static const String amapIosKey = String.fromEnvironment(
    'AMAP_IOS_KEY',
    defaultValue: 'ccfd86258803529a936a9d316ac8fda6',
  );

  static bool get isProd => flavor == 'prod';
  static bool get isDev => flavor == 'dev';
}
