/// PmcProvider — fetches /pmc?days=N and builds [PmcData] for the E2 screen.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/pmc_data.dart';

/// Family key is the number of days to fetch (30 / 90 / 180).
final pmcProvider =
    FutureProvider.autoDispose.family<PmcData, int>((ref, days) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');

  final response = await api.getPMC(userId, days: days);

  if (response.pmc.isEmpty) return PmcData.empty;

  final points =
      response.pmc.map(PmcPoint.fromRecord).toList(growable: false);

  final summary = PmcSummary.fromBackend(response.summary);

  return PmcData(points: points, summary: summary);
});