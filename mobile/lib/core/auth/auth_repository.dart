import 'package:dio/dio.dart';

import '../env/env.dart';
import 'auth_models.dart';
import 'token_storage.dart';

/// Talks to the auth-service for login / refresh / logout.
///
/// Mirrors the behavior of `frontend/src/store/authStore.ts` and the
/// `coros-sync auth` CLI group: simple email+password against
/// `/api/auth/login`, refresh-token-rotation on `/api/auth/refresh`.
class AuthRepository {
  AuthRepository({Dio? dio, TokenStorage? storage})
      : _dio = dio ?? _defaultAuthDio(),
        _storage = storage ?? TokenStorage();

  static Dio _defaultAuthDio() {
    return Dio(BaseOptions(
      baseUrl: Env.authUrl,
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 10),
      headers: {
        'X-Client-Id': Env.clientId,
        'Content-Type': 'application/json',
      },
      validateStatus: (s) => s != null && s < 500,
    ));
  }

  final Dio _dio;
  final TokenStorage _storage;

  Future<TokenSet> login({required String email, required String password}) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/api/auth/login',
      data: {'email': email, 'password': password},
    );
    if (res.statusCode != 200 || res.data == null) {
      throw AuthException(
        (res.data?['detail'] as String?) ?? '登录失败',
        statusCode: res.statusCode,
      );
    }
    final tokens = TokenSet.fromLoginJson(res.data!);
    await _storage.save(tokens);
    return tokens;
  }

  /// Register a new account.
  ///
  /// POSTs to `/api/auth/register`. Optional `inviteCode` is forwarded
  /// as `invite_code` (snake_case to match the auth-service convention).
  /// On success the response shape matches `/api/auth/login` and the
  /// returned tokens are persisted.
  Future<TokenSet> register({
    required String email,
    required String password,
    String? inviteCode,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/api/auth/register',
      data: {
        'email': email,
        'password': password,
        if (inviteCode != null && inviteCode.isNotEmpty) 'invite_code': inviteCode,
      },
    );
    if (res.statusCode != 200 || res.data == null) {
      throw AuthException(
        (res.data?['detail'] as String?) ?? '注册失败',
        statusCode: res.statusCode,
      );
    }
    final tokens = TokenSet.fromLoginJson(res.data!);
    await _storage.save(tokens);
    return tokens;
  }

  Future<TokenSet> refresh(TokenSet current) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/api/auth/refresh',
      data: {'refresh_token': current.refreshToken},
    );
    if (res.statusCode != 200 || res.data == null) {
      throw AuthException(
        'Token 已过期，请重新登录',
        statusCode: res.statusCode,
      );
    }
    final tokens = TokenSet.fromLoginJson(res.data!);
    await _storage.save(tokens);
    return tokens;
  }

  Future<void> logout() async {
    final stored = await _storage.read();
    if (stored != null) {
      // Best-effort server-side logout; do not block on failure.
      try {
        await _dio.post<void>(
          '/api/auth/logout',
          data: {'refresh_token': stored.refreshToken},
        );
      } catch (_) {
        // Network failure is acceptable; we still clear local tokens.
      }
    }
    await _storage.clear();
  }

  Future<TokenSet?> currentTokens() => _storage.read();
}
