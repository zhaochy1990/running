/// PmcProvider — fetches /pmc?days=N and builds [PmcData] for the E2 screen.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/pmc_data.dart';

/// Family key is the number of days to fetch (30 / 90 / 180).
final pmcProvider = FutureProvider.autoDispose.family<PmcData, int>((
  ref,
  days,
) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');

  final response = await api.getPMC(userId, days: days);

  // Plot STRIDE-computed acute/chronic/form (not COROS ati/cti).
  if (response.stridePmc.isEmpty) return PmcData.empty;

  final points = response.stridePmc
      .map(PmcPoint.fromStride)
      .toList(growable: false);

  final strideSummary = response.strideSummary;
  final summary = strideSummary != null
      ? PmcSummary.fromStride(strideSummary)
      : const PmcSummary();

  return PmcData(points: points, summary: summary);
});
