/// planDayProvider — fetches a single [DayPlan] for the given (date, sessionIndex).
///
/// Used by D6 PreTrainingScreen to load session details without requiring
/// the caller to know the full week folder structure.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/day_plan.dart';

/// Family parameter for [planDayProvider].
typedef PlanDayParams = ({String date, int sessionIndex});

/// FutureProvider that resolves a single [DayPlan].
///
/// Calls [StrideApi.getPlanDays] with `from=date, to=date` and extracts
/// `sessions[sessionIndex]` from the first (and only) returned day.
///
/// Throws [RangeError] if the day has fewer sessions than [sessionIndex].
/// Throws [StateError] if the API returns no days for the given date.
final planDayProvider =
    FutureProvider.autoDispose.family<DayPlan, PlanDayParams>(
  (ref, params) async {
    final api = ref.watch(strideApiProvider);
    final userId = ref.watch(currentUserIdProvider);
    if (userId == null) throw Exception('用户未登录');

    final response = await api.getPlanDays(
      userId,
      params.date,
      params.date,
    );

    if (response.days.isEmpty) {
      throw StateError('该日期无训练计划：${params.date}');
    }

    final day = response.days.first;

    if (params.sessionIndex < 0 || params.sessionIndex >= day.sessions.length) {
      throw RangeError(
        '课时索引越界：sessionIndex=${params.sessionIndex}, '
        'sessions.length=${day.sessions.length}',
      );
    }

    return DayPlan.fromPlanDay(day, params.sessionIndex);
  },
);
