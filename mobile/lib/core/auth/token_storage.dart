import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'auth_models.dart';

/// Persists [TokenSet] to platform secure storage.
///
/// Android: AndroidKeystore-backed.
/// iOS: Keychain.
class TokenStorage {
  TokenStorage([FlutterSecureStorage? storage])
      : _storage = storage ?? const FlutterSecureStorage(
          aOptions: AndroidOptions(encryptedSharedPreferences: true),
        );

  static const _key = 'stride.tokens.v1';

  final FlutterSecureStorage _storage;

  Future<void> save(TokenSet tokens) async {
    await _storage.write(key: _key, value: jsonEncode(tokens.toStoredJson()));
  }

  Future<TokenSet?> read() async {
    final raw = await _storage.read(key: _key);
    if (raw == null) return null;
    try {
      return TokenSet.fromStoredJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      // Corrupt entry — drop it and force re-login.
      await clear();
      return null;
    }
  }

  Future<void> clear() => _storage.delete(key: _key);

  /// 最近一次短信登录使用的手机号（#419 决议 4：会话失效回登录页时预填，
  /// 支持一键重发验证码）。非敏感，但与 token 同存 Keychain 免引入新依赖。
  static const _lastSmsPhoneKey = 'stride.sms.phone.v1';

  Future<String?> readLastSmsPhone() => _storage.read(key: _lastSmsPhoneKey);

  Future<void> writeLastSmsPhone(String phone) =>
      _storage.write(key: _lastSmsPhoneKey, value: phone);
}
