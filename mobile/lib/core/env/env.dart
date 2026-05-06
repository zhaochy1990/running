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
  /// STRIDE backend (FastAPI) base URL — all `/api/*` calls.
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue:
        'https://stride-app.victoriousdesert-bd552447.southeastasia.azurecontainerapps.io',
  );

  /// auth-service base URL — `/api/auth/login`, `/refresh`, `/logout`.
  static const String authUrl = String.fromEnvironment(
    'AUTH_URL',
    defaultValue:
        'https://auth-backend.delightfulwave-240938c0.southeastasia.azurecontainerapps.io',
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

  static bool get isProd => flavor == 'prod';
  static bool get isDev => flavor == 'dev';
}
