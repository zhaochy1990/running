/// AbilitySnapshotProvider — fetches /ability/current for E4 radar screen.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/ability_snapshot.dart';

final abilitySnapshotProvider =
    FutureProvider.autoDispose<AbilitySnapshot>((ref) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');

  final json = await api.getAbilityCurrentRaw(userId);
  return AbilitySnapshot.fromJson(json);
});
