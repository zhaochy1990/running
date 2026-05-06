import 'package:dio/dio.dart';
import 'package:logger/logger.dart';

import '../auth/auth_models.dart';
import '../auth/auth_repository.dart';

/// Attaches `Authorization: Bearer <access>` to every outgoing request and
/// silently refreshes the token once on 401.
///
/// Mirrors `frontend/src/api.ts:20-34` behavior. After a second 401, the
/// onUnauthorizedAfterRefresh callback fires so the app can navigate to /login.
class AuthInterceptor extends QueuedInterceptor {
  AuthInterceptor({
    required this.authRepository,
    required this.onUnauthorizedAfterRefresh,
    Logger? logger,
  }) : _log = logger ?? Logger();

  final AuthRepository authRepository;
  final void Function() onUnauthorizedAfterRefresh;
  final Logger _log;

  TokenSet? _cachedTokens;

  Future<TokenSet?> _tokens() async {
    _cachedTokens ??= await authRepository.currentTokens();
    return _cachedTokens;
  }

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    final tokens = await _tokens();
    if (tokens != null && !tokens.isExpired) {
      options.headers['Authorization'] = 'Bearer ${tokens.accessToken}';
    } else if (tokens != null) {
      // Token already expired — refresh proactively
      try {
        final refreshed = await authRepository.refresh(tokens);
        _cachedTokens = refreshed;
        options.headers['Authorization'] = 'Bearer ${refreshed.accessToken}';
      } on AuthException {
        _cachedTokens = null;
        onUnauthorizedAfterRefresh();
        return handler.reject(
          DioException(requestOptions: options, error: 'session_expired'),
        );
      }
    }
    handler.next(options);
  }

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final response = err.response;
    if (response?.statusCode != 401) {
      return handler.next(err);
    }

    final tokens = _cachedTokens;
    if (tokens == null) {
      onUnauthorizedAfterRefresh();
      return handler.next(err);
    }

    // First 401 — try silent refresh, then retry original request once.
    try {
      _log.d('Got 401, attempting silent refresh');
      final refreshed = await authRepository.refresh(tokens);
      _cachedTokens = refreshed;
      final retryOptions = err.requestOptions
        ..headers['Authorization'] = 'Bearer ${refreshed.accessToken}';
      final dio = Dio(BaseOptions(
        baseUrl: retryOptions.baseUrl,
        headers: retryOptions.headers,
        connectTimeout: retryOptions.connectTimeout,
        receiveTimeout: retryOptions.receiveTimeout,
      ));
      final retryResponse = await dio.fetch<dynamic>(retryOptions);
      handler.resolve(retryResponse);
    } on AuthException {
      _cachedTokens = null;
      onUnauthorizedAfterRefresh();
      handler.next(err);
    } catch (_) {
      handler.next(err);
    }
  }

  /// Reset cached tokens — call after login or logout so the next request
  /// reads fresh from storage.
  void invalidateCache() {
    _cachedTokens = null;
  }
}
