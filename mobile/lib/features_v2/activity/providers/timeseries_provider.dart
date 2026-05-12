import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/timeseries_data.dart';

/// Parameter record for the timeseries provider family.
typedef TimeseriesParams = ({String id, Set<String> fields});

/// Lazily fetches downsampled timeseries for an activity.
///
/// Callers should only watch this provider once the chart area scrolls
/// into the viewport (lazy-load behaviour per AC7). Marked autoDispose so
/// series data is freed when the detail screen exits.
final timeseriesProvider =
    FutureProvider.autoDispose
        .family<TimeseriesData, TimeseriesParams>((ref, params) async {
  final api = ref.watch(strideApiProvider);
  final userId = ref.watch(currentUserIdProvider);
  if (userId == null) throw Exception('用户未登录');
  return api.getActivityTimeseries(
    userId,
    params.id,
    downsample: 300,
    fields: params.fields,
  );
});
