import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

part 'database.g.dart';

/// Cache tables — these are NOT a source of truth, just a stale-while-
/// revalidate buffer per plan §4 "Offline strategy". Cache TTL = 5 min;
/// pull-to-refresh always wins.

@DataClassName('CachedActivityRow')
class CachedActivities extends Table {
  TextColumn get user => text()();
  TextColumn get labelId => text()();
  TextColumn get jsonBlob => text()();
  DateTimeColumn get cachedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {user, labelId};
}

@DataClassName('CachedPlanRow')
class CachedPlan extends Table {
  /// Composite key on (user, scope) where scope is 'today', 'week:2026-W19',
  /// etc. Lets us cache multiple plan slices independently.
  TextColumn get user => text()();
  TextColumn get scope => text()();
  TextColumn get jsonBlob => text()();
  DateTimeColumn get cachedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {user, scope};
}

@DataClassName('CachedHealthRow')
class CachedHealth extends Table {
  TextColumn get user => text()();
  TextColumn get scope => text()();
  TextColumn get jsonBlob => text()();
  DateTimeColumn get cachedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {user, scope};
}

@DataClassName('CachedTeamFeedRow')
class CachedTeamFeed extends Table {
  TextColumn get teamId => text()();
  TextColumn get jsonBlob => text()();
  DateTimeColumn get cachedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {teamId};
}

@DriftDatabase(tables: [CachedActivities, CachedPlan, CachedHealth, CachedTeamFeed])
class StrideDatabase extends _$StrideDatabase {
  StrideDatabase() : super(_open());

  @override
  int get schemaVersion => 1;
}

LazyDatabase _open() {
  return LazyDatabase(() async {
    final dir = await getApplicationSupportDirectory();
    final file = File(p.join(dir.path, 'stride_cache.sqlite'));
    return NativeDatabase.createInBackground(file);
  });
}

final databaseProvider = Provider<StrideDatabase>((ref) {
  final db = StrideDatabase();
  ref.onDispose(db.close);
  return db;
});
