/// Meal log providers.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/stride_api.dart';
import '../../../core/auth/current_user.dart';
import '../models/meals_daily.dart';

/// Family provider keyed by date string (YYYY-MM-DD).
final mealsDailyProvider =
    FutureProvider.autoDispose.family<MealsDaily?, String>((ref, date) async {
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) return null;
  final api = ref.watch(strideApiProvider);
  return api.getDailyMeals(userId, date: date);
});
