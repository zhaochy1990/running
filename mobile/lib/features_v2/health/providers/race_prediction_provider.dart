/// RacePredictionProvider — fetches /race-predictions for E5 screen.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/race_prediction.dart';

final racePredictionProvider =
    FutureProvider.autoDispose<RacePrediction>((ref) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');

  final json = await api.getRacePredictions(userId);
  return RacePrediction.fromJson(json);
});

/// History provider for FM trend chart.
final racePredictionHistoryProvider =
    FutureProvider.autoDispose<List<PredictionHistoryPoint>>((ref) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');

  final json = await api.getRacePredictionsHistory(userId, days: 180);
  final raw = (json['history'] as List? ?? const [])
      .cast<Map<String, dynamic>>();
  return raw.map(PredictionHistoryPoint.fromJson).toList(growable: false);
});
