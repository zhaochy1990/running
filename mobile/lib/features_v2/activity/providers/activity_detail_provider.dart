import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/activity_detail.dart';

/// Fetches activity detail (without timeseries) for a single activity.
///
/// `family` parameter is the `label_id` string.
/// `autoDispose` releases cached data when the screen pops.
final activityDetailProvider =
    FutureProvider.autoDispose.family<ActivityDetailV2, String>((ref, id) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');
  return api.getActivityDetail(userId, id);
});
