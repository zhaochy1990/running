import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Tracks whether we've already shown the pre-permission rationale screen.
/// Lives in secure storage (overkill, but reuses the storage we already
/// have — no extra dep on shared_preferences).
class RationaleStorage {
  RationaleStorage([FlutterSecureStorage? storage])
      : _storage = storage ?? const FlutterSecureStorage(
          aOptions: AndroidOptions(encryptedSharedPreferences: true),
        );

  static const _key = 'stride.notifications.rationale_shown';

  final FlutterSecureStorage _storage;

  Future<bool> hasShown() async {
    return (await _storage.read(key: _key)) == '1';
  }

  Future<void> markShown() async {
    await _storage.write(key: _key, value: '1');
  }

  Future<void> reset() => _storage.delete(key: _key);
}
