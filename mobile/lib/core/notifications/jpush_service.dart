import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:jpush_flutter/jpush_flutter.dart';
import 'package:jpush_flutter/jpush_interface.dart';
import 'package:logger/logger.dart';

import '../../data/api/stride_api.dart';

/// Thin wrapper around the `jpush_flutter` plugin.
///
/// Init flow (called once after authenticated launch):
///   1. setup() — registers AppKey + production flag
///   2. setAuth(true) — required by JPush 3.x to actually send pushes
///   3. addEventHandler() — wires foreground/background/tap callbacks
///   4. applyPushAuthority() — iOS only; on Android the manifest /
///      POST_NOTIFICATIONS prompt is handled at the system layer when
///      the first notification arrives.
///   5. getRegistrationID() — long-poll until ID assigned (1-3s)
///   6. registerDevice() — POST to STRIDE backend
///
/// All steps are wrapped in try/catch so a JPush hiccup never crashes the
/// app; failures are logged and the rest of init continues.
class JPushService {
  JPushService({required this.api, Logger? logger})
      : _log = logger ?? Logger();

  final StrideApi api;
  final Logger _log;
  final JPushFlutterInterface _jpush = JPush.newJPush();

  bool _initialized = false;
  String? _registrationId;

  String? get registrationId => _registrationId;

  Future<void> init({
    required String appKey,
    required String channel,
    required bool production,
    void Function(Map<String, dynamic> notification)? onTap,
  }) async {
    if (_initialized) return;
    try {
      _jpush.addEventHandler(
        onReceiveNotification: (Map<String, dynamic> msg) async {
          _log.i('jpush onReceiveNotification: $msg');
        },
        onReceiveMessage: (Map<String, dynamic> msg) async {
          _log.i('jpush onReceiveMessage: $msg');
        },
        onOpenNotification: (Map<String, dynamic> msg) async {
          _log.i('jpush onOpenNotification: $msg');
          if (onTap != null) onTap(msg);
        },
      );
      _jpush.setup(
        appKey: appKey,
        channel: channel,
        production: production,
      );
      _jpush.setAuth(enable: true);
      try {
        _jpush.applyPushAuthority();
      } catch (e) {
        _log.w('applyPushAuthority failed: $e');
      }
      _initialized = true;
    } catch (e, st) {
      _log.w('JPush init failed: $e\n$st');
    }
  }

  /// Polls until the JPush registration ID is assigned (up to ~5s),
  /// then POSTs it to the STRIDE backend.
  Future<String?> registerOnServer({String? appVersion}) async {
    if (!_initialized) return null;
    String? regId;
    for (var i = 0; i < 10; i++) {
      try {
        regId = await _jpush.getRegistrationID();
        if (regId.isNotEmpty) break;
      } catch (e) {
        _log.w('getRegistrationID failed: $e');
      }
      await Future<void>.delayed(const Duration(milliseconds: 500));
    }
    if (regId == null || regId.isEmpty) {
      _log.w('JPush registration ID never arrived; skipping server register');
      return null;
    }
    _registrationId = regId;
    try {
      await api.registerDevice(
        registrationId: regId,
        platform: defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android',
        appVersion: appVersion,
      );
      _log.i('Device registered with STRIDE backend (id=${regId.substring(0, 8)}...)');
    } catch (e) {
      _log.w('registerDevice() failed: $e');
    }
    return regId;
  }

  Future<void> deregisterOnLogout() async {
    final id = _registrationId;
    if (id == null) return;
    try {
      await api.unregisterDevice(id);
    } catch (e) {
      _log.w('unregisterDevice failed: $e');
    }
    _registrationId = null;
  }
}

final jpushServiceProvider = Provider<JPushService>((ref) {
  return JPushService(api: ref.watch(strideApiProvider));
});
