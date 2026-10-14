/// 手表绑定状态 — GET /api/users/me/watch（Go `watchInfoResponse` 镜像，
/// 契约同小程序 services/watch.ts）。未绑定时 200 但字符串字段全 null、
/// capabilities 为空数组。
class WatchInfo {
  const WatchInfo({
    this.provider,
    this.providerDisplayName,
    this.loggedIn = false,
    this.email,
    this.device,
    this.lastSyncAt,
    this.capabilities = const [],
  });

  factory WatchInfo.fromJson(Map<String, dynamic> json) => WatchInfo(
    provider: json['provider'] as String?,
    providerDisplayName: json['provider_display_name'] as String?,
    loggedIn: json['logged_in'] == true,
    email: json['email'] as String?,
    device: json['device'] as String?,
    lastSyncAt: json['last_sync_at'] as String?,
    capabilities: ((json['capabilities'] as List?) ?? const [])
        .whereType<String>()
        .toList(growable: false),
  );

  final String? provider;

  /// 后端展示名（如「高驰」）；空时回退 [provider]。
  final String? providerDisplayName;
  final bool loggedIn;
  final String? email;

  /// 最新活动设备型号。
  final String? device;

  /// 最近一次成功同步（UTC ISO 8601；Go watch_sync job 成功后写 sync_meta）。
  final String? lastSyncAt;
  final List<String> capabilities;

  bool get bound => loggedIn;

  String get brandLabel =>
      (providerDisplayName?.isNotEmpty ?? false) ? providerDisplayName! : (provider ?? '');

  /// last_sync_at 的相对时间文案（刚刚 / N 分钟前 / N 小时前 / N 天前）。
  String? get lastSyncText => lastSyncAt == null ? null : relativeTime(lastSyncAt!);
}

/// UTC ISO 时间 → 相对时间，镜像小程序 profile 页 relativeTime。
String relativeTime(String isoUtc) {
  final t = DateTime.tryParse(isoUtc);
  if (t == null) return isoUtc;
  var ms = DateTime.now().difference(t).inMilliseconds;
  if (ms < 0) ms = 0;
  final min = ms ~/ 60000;
  if (min < 1) return '刚刚';
  if (min < 60) return '$min 分钟前';
  final hr = min ~/ 60;
  if (hr < 24) return '$hr 小时前';
  return '${hr ~/ 24} 天前';
}
