import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/activity_detail.dart';

/// Fetches activity detail for a single activity, inlining the timeseries
/// (`?include=timeseries`)。地图与曲线共用这一份数据——Go API 的
/// `/timeseries` 子路径不存在（404），唯一的 timeseries 来源是 detail。
///
/// `family` parameter is the `label_id` string.
/// `autoDispose` releases cached data when the screen pops.
final activityDetailProvider = FutureProvider.autoDispose
    .family<ActivityDetailV2, String>((ref, id) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');
  return api.getActivityDetail(userId, id, includeTimeseries: true);
});
