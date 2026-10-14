/// Auth-service token set (matches /api/auth/login response shape).
library;

import 'auth_error_messages.dart';

class TokenSet {
  const TokenSet({
    required this.accessToken,
    required this.refreshToken,
    required this.expiresAt,
  });

  factory TokenSet.fromLoginJson(Map<String, dynamic> json) {
    final access = json['access_token'] as String;
    final refresh = json['refresh_token'] as String;
    // expires_in is seconds-from-now; convert to absolute UTC timestamp
    final expiresIn = (json['expires_in'] as num?)?.toInt() ?? 3600;
    return TokenSet(
      accessToken: access,
      refreshToken: refresh,
      expiresAt: DateTime.now().toUtc().add(Duration(seconds: expiresIn)),
    );
  }

  factory TokenSet.fromStoredJson(Map<String, dynamic> json) {
    return TokenSet(
      accessToken: json['access_token'] as String,
      refreshToken: json['refresh_token'] as String,
      expiresAt: DateTime.parse(json['expires_at'] as String),
    );
  }

  final String accessToken;
  final String refreshToken;
  final DateTime expiresAt;

  /// True if access token expires within 60 seconds (refresh window).
  bool get isExpiringSoon =>
      DateTime.now().toUtc().add(const Duration(seconds: 60)).isAfter(expiresAt);

  bool get isExpired => DateTime.now().toUtc().isAfter(expiresAt);

  Map<String, dynamic> toStoredJson() => {
        'access_token': accessToken,
        'refresh_token': refreshToken,
        'expires_at': expiresAt.toIso8601String(),
      };
}

class AuthException implements Exception {
  const AuthException(
    this.message, {
    this.statusCode,
    this.code,
  });

  final String message;

  /// auth-service 错误体里的 `error` 机器码（如 sms_send_cooldown）。
  /// 网络层异常等没有服务端错误体的场景为 null。
  final String? code;

  final int? statusCode;

  /// 展示给用户的中文文案（按机器码映射，回落到服务端原文）。
  String get localized => authErrorMessage(code, server: message);

  @override
  String toString() => 'AuthException($statusCode $code): $message';
}
