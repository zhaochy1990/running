import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/activity_detail.dart';
import 'activity_detail_provider.dart';

/// Lazily exposes the timeseries points for one activity.
///
/// Derives from [activityDetailProvider] (`?include=timeseries`) so charts and
/// the track map share one fetch — the standalone `/timeseries` subpath 404s
/// on the Go API. Sync invalidates both providers (see sync_controller).
final timeseriesProvider = FutureProvider.autoDispose
    .family<List<TsPoint>, String>((ref, id) async {
      final detail = await ref.watch(activityDetailProvider(id).future);
      return detail.timeseries;
    });
