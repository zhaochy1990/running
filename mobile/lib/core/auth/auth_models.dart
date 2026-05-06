/// Auth-service token set (matches /api/auth/login response shape).
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
  const AuthException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() => 'AuthException($statusCode): $message';
}
