import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:logger/logger.dart';

import '../api/stride_api.dart';
import '../db/database.dart';
import '../models/plan.dart';
import 'cache_policy.dart';

class PlanRepository {
  PlanRepository(this._api, this._db, [Logger? logger])
      : _log = logger ?? Logger();

  final StrideApi _api;
  final StrideDatabase _db;
  final Logger _log;

  Stream<PlanTodayResponse> watchToday(String user) async* {
    const scope = 'today';
    final cacheRow = await (_db.select(_db.cachedPlan)
          ..where((t) => t.user.equals(user) & t.scope.equals(scope)))
        .getSingleOrNull();

    if (cacheRow != null) {
      try {
        yield PlanTodayResponse.fromJson(
          jsonDecode(cacheRow.jsonBlob) as Map<String, dynamic>,
        );
        if (!isStale(cacheRow.cachedAt)) return;
      } catch (e) {
        _log.w('cached plan decode failed: $e');
      }
    }

    try {
      final fresh = await _api.getPlanToday(user);
      await _db.into(_db.cachedPlan).insertOnConflictUpdate(
            CachedPlanCompanion.insert(
              user: user,
              scope: scope,
              jsonBlob: jsonEncode(fresh.toJson()),
              cachedAt: DateTime.now(),
            ),
          );
      yield fresh;
    } catch (e) {
      _log.w('plan/today fetch failed: $e');
      if (cacheRow == null) rethrow;
    }
  }

  Stream<PlanDaysResponse> watchDays(String user, String from, String to) async* {
    final scope = 'days:$from..$to';
    final cacheRow = await (_db.select(_db.cachedPlan)
          ..where((t) => t.user.equals(user) & t.scope.equals(scope)))
        .getSingleOrNull();

    if (cacheRow != null) {
      try {
        yield PlanDaysResponse.fromJson(
          jsonDecode(cacheRow.jsonBlob) as Map<String, dynamic>,
        );
        if (!isStale(cacheRow.cachedAt)) return;
      } catch (e) {
        _log.w('cached plan-days decode failed: $e');
      }
    }

    try {
      final fresh = await _api.getPlanDays(user, from, to);
      await _db.into(_db.cachedPlan).insertOnConflictUpdate(
            CachedPlanCompanion.insert(
              user: user,
              scope: scope,
              jsonBlob: jsonEncode(fresh.toJson()),
              cachedAt: DateTime.now(),
            ),
          );
      yield fresh;
    } catch (e) {
      _log.w('plan/days fetch failed: $e');
      if (cacheRow == null) rethrow;
    }
  }
}

final planRepositoryProvider = Provider<PlanRepository>((ref) {
  return PlanRepository(
    ref.watch(strideApiProvider),
    ref.watch(databaseProvider),
  );
});
