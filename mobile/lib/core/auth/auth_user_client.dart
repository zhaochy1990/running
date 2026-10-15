/// auth-service 身份面客户端 —— GET/PATCH `/api/users/me`（昵称/邮箱/头像）
/// 与 POST `/api/users/me/avatar`（multipart → 腾讯云 COS，服务端持凭据）。
///
/// 与数据面（Go API `/api/users/me/profile`）分库：身份字段走 auth-service
/// （ADR 0013，同小程序 profile-edit 的拆分）。Dio 基址是 [Env.authUrl]，
/// 复用 [AuthInterceptor] 的 Bearer + 静默刷新。
library;

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/auth_interceptor.dart';
import '../env/env.dart';
import 'auth_controller.dart';

/// auth-service `/api/users/me` 返回的身份档案（只取 App 用到的字段）。
class AuthUserProfile {
  const AuthUserProfile({
    required this.id,
    this.name,
    this.email,
    this.avatarUrl,
  });

  factory AuthUserProfile.fromJson(Map<String, dynamic> json) =>
      AuthUserProfile(
        id: json['id'] as String,
        name: json['name'] as String?,
        email: json['email'] as String?,
        avatarUrl: json['avatar_url'] as String?,
      );

  final String id;
  final String? name;
  final String? email;
  final String? avatarUrl;

  AuthUserProfile copyWith({String? name, String? avatarUrl}) =>
      AuthUserProfile(
        id: id,
        name: name ?? this.name,
        email: email,
        avatarUrl: avatarUrl ?? this.avatarUrl,
      );
}

/// 身份面薄客户端（手写直调，无 codegen —— 同 StrideApi 约定）。
///
/// Dio 配置 validateStatus<500，4xx 不抛 —— 每个方法显式检查状态码。
class AuthUserClient {
  AuthUserClient(this._dio);

  final Dio _dio;

  /// GET /api/users/me —— 身份档案。
  Future<AuthUserProfile> getMe() async {
    final res = await _dio.get<Map<String, dynamic>>('/api/users/me');
    _ensureOk(res, 'identity_fetch_failed');
    return AuthUserProfile.fromJson(res.data!);
  }

  /// PATCH /api/users/me —— 更新昵称（auth-service 只认 name/avatar_url）。
  Future<AuthUserProfile> updateName(String name) async {
    final res = await _dio.patch<Map<String, dynamic>>(
      '/api/users/me',
      data: {'name': name},
    );
    _ensureOk(res, 'name_save_failed');
    return AuthUserProfile.fromJson(res.data!);
  }

  /// POST /api/users/me/avatar —— multipart 上传（≤2MB），服务端落 COS
  /// 并回写 avatar_url（带 ?v= 时间戳防 CDN 缓存）。
  Future<String> uploadAvatar(String filePath, String fileName) async {
    final form = FormData.fromMap(<String, dynamic>{
      'file': await MultipartFile.fromFile(filePath, filename: fileName),
    });
    final res = await _dio.post<Map<String, dynamic>>(
      '/api/users/me/avatar',
      data: form,
    );
    _ensureOk(res, 'avatar_upload_failed');
    final url = res.data!['avatar_url'] as String?;
    if (url == null || url.isEmpty) {
      throw StateError('avatar_upload_failed');
    }
    return url;
  }

  void _ensureOk(Response<Map<String, dynamic>?> res, String code) {
    if ((res.statusCode ?? 0) ~/ 100 != 2 || res.data == null) {
      throw StateError('$code:${res.statusCode}');
    }
  }
}

final authUserClientProvider = Provider<AuthUserClient>((ref) {
  final dio = Dio(BaseOptions(
    baseUrl: Env.authUrl,
    connectTimeout: const Duration(seconds: 15),
    receiveTimeout: const Duration(seconds: 30),
    headers: {'Accept': 'application/json', 'X-Client-Id': Env.clientId},
    validateStatus: (s) => s != null && s < 500,
  ));
  dio.interceptors.add(AuthInterceptor(
    authRepository: ref.read(authRepositoryProvider),
    onUnauthorizedAfterRefresh: () {
      Future<void>(
          () => ref.read(authControllerProvider.notifier).logout());
    },
  ));
  return AuthUserClient(dio);
});

/// 我 tab 头像 URL（auth-service 身份面 GET /api/users/me，ADR 0013）。
/// 未登录或请求失败都回 null —— 头像可缺失，UI 回退首字母。
final avatarUrlProvider = FutureProvider<String?>((ref) async {
  final auth = ref.watch(authControllerProvider);
  if (auth is! AuthAuthenticated) return null;
  try {
    return (await ref.watch(authUserClientProvider).getMe()).avatarUrl;
  } catch (_) {
    return null;
  }
});
