import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:logger/logger.dart';

import '../api/stride_api.dart';
import '../db/database.dart';
import '../models/health.dart';
import 'cache_policy.dart';

class HealthRepository {
  HealthRepository(this._api, this._db, [Logger? logger])
      : _log = logger ?? Logger();

  final StrideApi _api;
  final StrideDatabase _db;
  final Logger _log;

  Stream<HealthResponse> watchHealth(String user, {int days = 30}) async* {
    final scope = 'health:$days';
    final cacheRow = await (_db.select(_db.cachedHealth)
          ..where((t) => t.user.equals(user) & t.scope.equals(scope)))
        .getSingleOrNull();

    if (cacheRow != null) {
      try {
        yield HealthResponse.fromJson(
          jsonDecode(cacheRow.jsonBlob) as Map<String, dynamic>,
        );
        if (!isStale(cacheRow.cachedAt)) return;
      } catch (e) {
        _log.w('cached health decode failed: $e');
      }
    }

    try {
      final fresh = await _api.getHealth(user, days: days);
      await _db.into(_db.cachedHealth).insertOnConflictUpdate(
            CachedHealthCompanion.insert(
              user: user,
              scope: scope,
              jsonBlob: jsonEncode(fresh.toJson()),
              cachedAt: DateTime.now(),
            ),
          );
      yield fresh;
    } catch (e) {
      _log.w('health fetch failed: $e');
      if (cacheRow == null) rethrow;
    }
  }

  Stream<PMCResponse> watchPmc(String user, {int days = 90}) async* {
    final scope = 'pmc:$days';
    final cacheRow = await (_db.select(_db.cachedHealth)
          ..where((t) => t.user.equals(user) & t.scope.equals(scope)))
        .getSingleOrNull();

    if (cacheRow != null) {
      try {
        yield PMCResponse.fromJson(
          jsonDecode(cacheRow.jsonBlob) as Map<String, dynamic>,
        );
        if (!isStale(cacheRow.cachedAt)) return;
      } catch (e) {
        _log.w('cached pmc decode failed: $e');
      }
    }

    try {
      final fresh = await _api.getPMC(user, days: days);
      await _db.into(_db.cachedHealth).insertOnConflictUpdate(
            CachedHealthCompanion.insert(
              user: user,
              scope: scope,
              jsonBlob: jsonEncode(fresh.toJson()),
              cachedAt: DateTime.now(),
            ),
          );
      yield fresh;
    } catch (e) {
      _log.w('pmc fetch failed: $e');
      if (cacheRow == null) rethrow;
    }
  }
}

final healthRepositoryProvider = Provider<HealthRepository>((ref) {
  return HealthRepository(
    ref.watch(strideApiProvider),
    ref.watch(databaseProvider),
  );
});
