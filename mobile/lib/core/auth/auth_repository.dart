import 'package:dio/dio.dart';

import '../env/env.dart';
import 'auth_models.dart';
import 'token_storage.dart';

/// Talks to the auth-service for login / refresh / logout / SMS login.
///
/// Mirrors the behavior of `frontend/src/store/authStore.ts` and the
/// `coros-sync auth` CLI group: simple email+password against
/// `/api/auth/login`, refresh-token-rotation on `/api/auth/refresh`,
/// phone+code login-or-register against `/api/auth/sms/*`.
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

  /// auth-service 错误体是 `{error, message}`（机器码 + 英文描述）。
  /// 中文映射在 UI 层按 [AuthException.localized] 完成。
  AuthException _error(Response<Map<String, dynamic>?> res, String fallback) {
    final body = res.data;
    return AuthException(
      (body?['message'] as String?) ?? fallback,
      statusCode: res.statusCode,
      code: body?['error'] as String?,
    );
  }

  Future<TokenSet> login({required String email, required String password}) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/api/auth/login',
      data: {'email': email, 'password': password},
    );
    if (res.statusCode != 200 || res.data == null) {
      throw _error(res, '登录失败');
    }
    final tokens = TokenSet.fromLoginJson(res.data!);
    await _storage.save(tokens);
    return tokens;
  }

  /// Register a new account.
  ///
  /// POSTs to `/api/auth/register`. Optional `inviteCode` is forwarded
  /// as `invite_code` (snake_case to match the auth-service convention).
  /// On success the service answers 201 with the same shape as
  /// `/api/auth/login` and the returned tokens are persisted.
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
    // Go 侧注册成功回 201 Created（auth.go Register）。
    if ((res.statusCode != 200 && res.statusCode != 201) || res.data == null) {
      throw _error(res, '注册失败');
    }
    final tokens = TokenSet.fromLoginJson(res.data!);
    await _storage.save(tokens);
    return tokens;
  }

  /// Sends a login-scene SMS verification code to [phone].
  ///
  /// Mirrors the miniprogram's bind-phone flow minus the WeChat wrapper:
  /// login-or-register, so any valid mainland phone can receive a code.
  /// The 60s cooldown / daily cap are enforced server-side; violations come
  /// back as 429 machine codes mapped by [AuthException.localized].
  Future<void> sendSmsCode({required String phone}) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/api/auth/sms/send',
      data: {'phone': phone, 'scene': 'login'},
    );
    if (res.statusCode != 200 || res.data?['status'] != 'ok') {
      throw _error(res, '验证码发送失败');
    }
  }

  /// Verifies a login code and exchanges it for tokens (login-or-register:
  /// a first-time phone auto-creates the account, invite-gated only when the
  /// server turns the gate on — [inviteCode] is forwarded whenever supplied).
  Future<TokenSet> verifySmsCode({
    required String phone,
    required String code,
    String? inviteCode,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/api/auth/sms/verify',
      data: {
        'phone': phone,
        'code': code,
        if (inviteCode != null && inviteCode.isNotEmpty) 'invite_code': inviteCode,
      },
    );
    if (res.statusCode != 200 || res.data == null) {
      throw _error(res, '验证码校验失败');
    }
    final tokens = TokenSet.fromLoginJson(res.data!);
    await _storage.save(tokens);
    // 会话失效回到登录页时预填该手机号（#419 决议 4）。
    await _storage.writeLastSmsPhone(phone);
    return tokens;
  }

  Future<String?> lastSmsPhone() => _storage.readLastSmsPhone();

  Future<TokenSet> refresh(TokenSet current) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/api/auth/refresh',
      data: {'refresh_token': current.refreshToken},
    );
    if (res.statusCode != 200 || res.data == null) {
      throw _error(res, 'Token 已过期，请重新登录');
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
