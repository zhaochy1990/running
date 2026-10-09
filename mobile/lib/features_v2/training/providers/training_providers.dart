/// /training（训练 tab）数据源 —— 结构化周课表 + 当日实际活动。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../../../data/models/activity.dart';
import '../../../data/models/weekly_plan.dart';
import '../../../shared/utils/shanghai_date.dart';

/// 当前周的结构化课表（weekName = 上海本周目录名）。
/// 拉取失败（未生成计划 / 网络）时置 null，由界面渲染空态。
final weeklyPlanProvider =
    FutureProvider.autoDispose<WeeklyPlanDetail?>((ref) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');
  try {
    return await api.getWeeklyPlan(userId, currentWeekName());
  } catch (_) {
    return null;
  }
});

/// 指定日（上海 YYYY-MM-DD）的实际活动记录；失败置空（卡片不展示）。
final dayActivitiesProvider =
    FutureProvider.autoDispose.family<List<Activity>, String>((ref, date) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');
  try {
    return await api.listActivities(userId, from: date, to: date, limit: 20);
  } catch (_) {
    return const [];
  }
});
