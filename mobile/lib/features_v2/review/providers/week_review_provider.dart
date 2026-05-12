/// Riverpod provider for the weekly review screen (D9).
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/week_review.dart';

/// Fetches the weekly review for [folder] (e.g. "2026-05-04_05-10(W1)").
///
/// `autoDispose` + `family` so each folder gets its own cache entry and
/// is released when the screen leaves the widget tree.
final weekReviewProvider =
    FutureProvider.autoDispose.family<WeekReview, String>((ref, folder) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');
  return api.getWeekReview(userId, folder);
});
