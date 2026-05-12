import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/stride_api.dart';
import '../../../core/auth/current_user.dart';
import '../models/home_data.dart';

/// Fetches the aggregated home data for the current user.
///
/// `autoDispose` so the data is cleared when the screen leaves the tree
/// (pull-to-refresh will always get a fresh value on return).
final homeProvider = FutureProvider.autoDispose<HomeData>((ref) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');
  return api.getHome(userId, recentDays: 7);
});
