/// TrainingStatusProvider — 训练状态页（#465）一次性拉齐 5 个数据面接口：
///
///   GET /health?days=90          RHR 逐日 + 基线 + HRV 快照
///   GET /hrv?days=90             逐日 HRV
///   GET /stride/zones            阈值 + 区间
///   GET /stride/training-load?days=112   负荷 current + series（16 周热力图）
///   GET /activities?date_from=   活动列表（热力图日详情，200/页分页拉全）
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../../../data/models/activity.dart';
import '../../../data/models/health.dart';
import '../../../data/models/training_status.dart';
import '../../../shared/utils/shanghai_date.dart';
import '../models/training_status_data.dart' show dayMs;

/// 聚合模型 —— 屏幕层只做切片（趋势窗口）/渲染，不再发请求。
class TrainingStatusData {
  const TrainingStatusData({
    required this.health,
    required this.hrv,
    required this.zones,
    required this.load,
    required this.activitiesByDate,
  });

  final HealthResponse health;
  final HrvResponse hrv;
  final StrideZonesResponse zones;
  final TrainingLoadResponse load;

  /// 上海 YYYY-MM-DD → 当日活动（按 API 返回顺序）。
  final Map<String, List<Activity>> activitiesByDate;
}

final trainingStatusProvider =
    FutureProvider.autoDispose<TrainingStatusData>((ref) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');

  final from = epochToShanghaiYmd(
    DateTime.now().millisecondsSinceEpoch - 112 * dayMs,
  );

  final results = await Future.wait([
    api.getHealth(userId, days: 90),
    api.getHrv(userId, days: 90),
    api.getStrideZones(userId),
    api.getStrideTrainingLoad(userId, days: 112),
    _fetchAllActivities(api, userId, from),
  ]);

  final activities = results[4] as List<Activity>;
  final byDate = <String, List<Activity>>{};
  for (final a in activities) {
    byDate.putIfAbsent(shanghaiDateFromIso(a.date), () => []).add(a);
  }

  return TrainingStatusData(
    health: results[0] as HealthResponse,
    hrv: results[1] as HrvResponse,
    zones: results[2] as StrideZonesResponse,
    load: results[3] as TrainingLoadResponse,
    activitiesByDate: byDate,
  );
});

/// 分页拉取 16 周窗口内的全部活动（服务端单页上限 200，取满一页才翻页）。
Future<List<Activity>> _fetchAllActivities(
  StrideApi api,
  String userId,
  String from,
) async {
  const pageSize = 200;
  final all = <Activity>[];
  var offset = 0;
  for (;;) {
    final page = await api.listActivities(
      userId,
      from: from,
      limit: pageSize,
      offset: offset,
    );
    all.addAll(page);
    if (page.length < pageSize) break;
    offset = all.length;
  }
  return all;
}
