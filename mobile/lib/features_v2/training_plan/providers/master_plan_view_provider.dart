/// C6 — Master plan view provider.
///
/// Fetches the current active master plan via GET /current.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/stride_api.dart';
import '../models/master_plan.dart';

/// Auto-dispose FutureProvider that loads the active MasterPlan.
/// Returns null when no active plan exists (404).
final masterPlanViewProvider =
    FutureProvider.autoDispose<MasterPlan?>((ref) async {
  final api = ref.watch(strideApiProvider);
  return api.getCurrentMasterPlan();
});
