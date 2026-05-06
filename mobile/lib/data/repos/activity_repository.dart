import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:logger/logger.dart';

import '../api/stride_api.dart';
import '../db/database.dart';
import '../models/activity.dart';
import 'cache_policy.dart';

/// Cache-first repository for activity data.
///
/// Read pattern:
///   1. Read cache; if found, emit it immediately
///   2. Fire network request in background
///   3. On success, update cache + re-emit
///   4. On failure with cache present, keep cache; surface error if no cache
class ActivityRepository {
  ActivityRepository(this._api, this._db, [Logger? logger])
      : _log = logger ?? Logger();

  final StrideApi _api;
  final StrideDatabase _db;
  final Logger _log;

  /// Watch a single activity detail. Emits cache → network result.
  Stream<ActivityDetailResponse> watchActivity(String user, String labelId) async* {
    final cacheRow = await (_db.select(_db.cachedActivities)
          ..where((t) => t.user.equals(user) & t.labelId.equals(labelId)))
        .getSingleOrNull();

    if (cacheRow != null) {
      try {
        final cached = ActivityDetailResponse.fromJson(
          jsonDecode(cacheRow.jsonBlob) as Map<String, dynamic>,
        );
        yield cached;
        if (!isStale(cacheRow.cachedAt)) return;
      } catch (e) {
        _log.w('cached activity decode failed: $e');
      }
    }

    try {
      final fresh = await _api.getActivity(user, labelId);
      await _db.into(_db.cachedActivities).insertOnConflictUpdate(
            CachedActivitiesCompanion.insert(
              user: user,
              labelId: labelId,
              jsonBlob: jsonEncode(fresh.toJson()),
              cachedAt: DateTime.now(),
            ),
          );
      yield fresh;
    } catch (e) {
      _log.w('activity fetch failed for $labelId: $e');
      if (cacheRow == null) rethrow;
    }
  }
}

final activityRepositoryProvider = Provider<ActivityRepository>((ref) {
  return ActivityRepository(
    ref.watch(strideApiProvider),
    ref.watch(databaseProvider),
  );
});
