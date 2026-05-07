import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:logger/logger.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';

import 'update_info.dart';

const _githubReleasesUrl =
    'https://api.github.com/repos/zhaochy1990/running/releases?per_page=20';
const _tagPrefix = 'mobile-v';
const _dismissedKey = 'stride.updater.dismissed_version';

/// One-shot provider that returns an `UpdateInfo` if a newer mobile release
/// is published on GitHub, otherwise `null`. Wraps any failure as `null` so
/// network hiccups never block app startup.
final updateAvailabilityProvider = FutureProvider<UpdateInfo?>((ref) async {
  // iOS will sideload differently (TestFlight in v2); skip for now.
  if (!Platform.isAndroid) return null;
  return ref.read(updateCheckerProvider).check();
});

final updateCheckerProvider = Provider<UpdateChecker>((ref) {
  return UpdateChecker();
});

class UpdateChecker {
  UpdateChecker({Dio? dio, FlutterSecureStorage? storage, Logger? logger})
      : _dio = dio ??
            Dio(
              BaseOptions(
                connectTimeout: const Duration(seconds: 8),
                receiveTimeout: const Duration(seconds: 30),
                headers: {
                  // Required by GitHub API; v3 is stable JSON shape.
                  'Accept': 'application/vnd.github+json',
                  'X-GitHub-Api-Version': '2022-11-28',
                  // The unauthenticated rate limit (60/h/IP) is plenty for
                  // a once-per-launch check.
                },
              ),
            ),
        _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            ),
        _log = logger ?? Logger();

  final Dio _dio;
  final FlutterSecureStorage _storage;
  final Logger _log;

  /// Returns the newest published mobile release if it is strictly greater
  /// than the running build AND the user has not previously dismissed it.
  Future<UpdateInfo?> check() async {
    try {
      final pkg = await PackageInfo.fromPlatform();
      final currentName = pkg.version; // e.g. "2026.5.1"

      final resp = await _dio.get<List<dynamic>>(_githubReleasesUrl);
      final releases = (resp.data ?? const [])
          .cast<Map<String, dynamic>>();

      for (final r in releases) {
        if (r['draft'] == true || r['prerelease'] == true) continue;
        final tag = r['tag_name'] as String? ?? '';
        if (!tag.startsWith(_tagPrefix)) continue;
        final versionName = tag.substring(_tagPrefix.length);
        if (!_isStrictlyGreater(versionName, currentName)) continue;
        final assets = (r['assets'] as List? ?? const [])
            .cast<Map<String, dynamic>>();
        final apk = assets.firstWhere(
          (a) =>
              (a['name'] as String? ?? '').toLowerCase().endsWith('.apk') &&
              (a['state'] as String? ?? 'uploaded') == 'uploaded',
          orElse: () => const {},
        );
        if (apk.isEmpty) continue;
        final dismissed = await _storage.read(key: _dismissedKey);
        if (dismissed == versionName) {
          _log.i('Update $versionName previously dismissed; skipping');
          return null;
        }
        return UpdateInfo(
          tagName: tag,
          versionName: versionName,
          apkUrl: apk['browser_download_url'] as String,
          apkSize: (apk['size'] as num?)?.toInt() ?? 0,
          releaseNotes: r['body'] as String?,
        );
      }
      return null;
    } catch (e, st) {
      _log.w('update check failed: $e\n$st');
      return null;
    }
  }

  /// User picked "稍后" — stop nagging for THIS version. The next release
  /// will overwrite the dismissed marker.
  Future<void> dismiss(String versionName) async {
    await _storage.write(key: _dismissedKey, value: versionName);
  }

  /// Download the APK to app's external cache dir and return its path.
  /// [onProgress] receives a 0..1 fraction.
  Future<String> downloadApk(
    UpdateInfo info, {
    void Function(double progress)? onProgress,
  }) async {
    final dir = await getApplicationCacheDirectory();
    final outPath = '${dir.path}/stride-${info.versionName}.apk';
    final out = File(outPath);
    if (await out.exists()) {
      // Resume detection is overkill for our scope; just re-download.
      await out.delete();
    }
    await _dio.download(
      info.apkUrl,
      outPath,
      options: Options(
        responseType: ResponseType.bytes,
        followRedirects: true,
        receiveTimeout: const Duration(minutes: 5),
        // GitHub Releases assets bypass the JSON Accept header.
        headers: {'Accept': 'application/octet-stream'},
      ),
      onReceiveProgress: (received, total) {
        if (total > 0 && onProgress != null) {
          onProgress(received / total);
        }
      },
    );
    if (!await out.exists() || (await out.length()) == 0) {
      throw Exception('Downloaded APK is empty: $outPath');
    }
    if (kDebugMode) {
      _log.i('APK downloaded: $outPath (${await out.length()} bytes)');
    }
    return outPath;
  }
}

/// Compares semver-like version strings ``a > b`` (numeric per-component).
/// e.g. ``2026.5.10`` > ``2026.5.2``. Trailing components default to 0.
bool _isStrictlyGreater(String a, String b) {
  final pa = _parts(a);
  final pb = _parts(b);
  final n = pa.length > pb.length ? pa.length : pb.length;
  for (var i = 0; i < n; i++) {
    final av = i < pa.length ? pa[i] : 0;
    final bv = i < pb.length ? pb[i] : 0;
    if (av != bv) return av > bv;
  }
  return false;
}

List<int> _parts(String v) {
  return v.split('.').map((s) => int.tryParse(s) ?? 0).toList();
}
