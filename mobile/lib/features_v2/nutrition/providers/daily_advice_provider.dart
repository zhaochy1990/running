/// Daily nutrition advice provider.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/stride_api.dart';
import '../../../core/auth/current_user.dart';
import '../models/daily_advice.dart';

/// Family provider keyed by date string (YYYY-MM-DD).
/// Returns null when the user has no nutrition prefs (404).
final dailyAdviceProvider =
    FutureProvider.autoDispose.family<DailyAdvice?, String>((ref, date) async {
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) return null;
  final api = ref.watch(strideApiProvider);
  return api.getDailyNutrition(userId, date: date);
});
