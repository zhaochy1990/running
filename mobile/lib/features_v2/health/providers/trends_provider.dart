/// TrendsProvider — fetches /health?days=N for the E3 trends screen.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../../../data/models/health.dart';

/// Family key is the number of days to fetch (7 / 30 / 90).
final trendsProvider =
    FutureProvider.autoDispose.family<List<HealthRecord>, int>((ref, days) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');

  final response = await api.getHealth(userId, days: days);
  // health list is DESC from backend; return as-is (newest first).
  return response.health;
});