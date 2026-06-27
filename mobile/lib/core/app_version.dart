import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

/// The app's version name (e.g. `2026.6.2`), read once from the platform
/// bundle. Use this instead of hard-coding a version string anywhere in the UI.
final appVersionProvider = FutureProvider<String>((ref) async {
  final info = await PackageInfo.fromPlatform();
  return info.version;
});
