/// TrainingStatusProvider — 训练状态页聚合数据（#465）。
///
/// 并行拉 5 个数据面端点（同小程序 training-status fetch）：
///   /health?days=90 · /hrv?days=90 · /stride/zones ·
///   /stride/training-load?days=112 · /activities（分页拉全，热力图日详情用）
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../../../data/models/activity.dart';
import '../../../data/models/health.dart';
import '../../../data/models/training_status.dart';
import '../../../shared/utils/shanghai_date.dart';

class TrainingStatusData {
  const TrainingStatusData({
    required this.health,
    required this.hrv,
    required this.zones,
    required this.load,
    required this.activitiesByDate,
  });

  final HealthResponse health;
  final HrvDailyResponse hrv;
  final StrideZonesResponse zones;
  final StrideTrainingLoadResponse load;

  /// 上海 YYYY-MM-DD → 当日活动（热力图点格详情）。
  final Map<String, List<Activity>> activitiesByDate;
}

final trainingStatusProvider =
    FutureProvider.autoDispose<TrainingStatusData>((ref) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');

  final from = epochToShanghaiYmd(
    DateTime.now().millisecondsSinceEpoch - 112 * 86400000,
  );

  // 服务端 limit 上限 200，按 total 分页拉全 16 周窗口。
  Future<List<Activity>> fetchAllActivities() async {
    const page = 200;
    final all = <Activity>[];
    var offset = 0;
    for (;;) {
      final resp = await api.listActivities(
        userId,
        from: from,
        limit: page,
        offset: offset,
      );
      all.addAll(resp);
      if (resp.length < page) break;
      offset = all.length;
    }
    return all;
  }

  final results = await Future.wait([
    api.getHealth(userId, days: 90),
    api.getHrvDaily(userId, days: 90),
    api.getStrideZones(userId),
    api.getStrideTrainingLoad(userId, days: 112),
    fetchAllActivities(),
  ]);

  final byDate = <String, List<Activity>>{};
  for (final a in results[4] as List<Activity>) {
    byDate.putIfAbsent(shanghaiDateFromIso(a.date), () => []).add(a);
  }

  return TrainingStatusData(
    health: results[0] as HealthResponse,
    hrv: results[1] as HrvDailyResponse,
    zones: results[2] as StrideZonesResponse,
    load: results[3] as StrideTrainingLoadResponse,
    activitiesByDate: byDate,
  );
});
