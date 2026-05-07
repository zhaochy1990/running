import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:logger/logger.dart';

import '../api/stride_api.dart';
import '../db/database.dart';
import '../models/team.dart';
import 'cache_policy.dart';

class TeamsRepository {
  TeamsRepository(this._api, this._db, [Logger? logger])
      : _log = logger ?? Logger();

  final StrideApi _api;
  final StrideDatabase _db;
  final Logger _log;

  Stream<TeamFeed> watchTeamFeed(String teamId, {int days = 30}) async* {
    final cacheRow = await (_db.select(_db.cachedTeamFeed)
          ..where((t) => t.teamId.equals(teamId)))
        .getSingleOrNull();

    if (cacheRow != null) {
      try {
        yield TeamFeed.fromJson(
          jsonDecode(cacheRow.jsonBlob) as Map<String, dynamic>,
        );
        if (!isStale(cacheRow.cachedAt)) return;
      } catch (e) {
        _log.w('cached team feed decode failed: $e');
      }
    }

    try {
      final fresh = await _api.getTeamFeed(teamId, days: days);
      await _db.into(_db.cachedTeamFeed).insertOnConflictUpdate(
            CachedTeamFeedCompanion.insert(
              teamId: teamId,
              jsonBlob: jsonEncode({
                'team_id': fresh.teamId,
                'member_count': fresh.memberCount,
                'activities': fresh.activities
                    .map((a) => {
                          ...a.activity.toJson(),
                          'user_id': a.userId,
                          'display_name': a.displayName,
                          'like_count': a.likeCount,
                          'you_liked': a.youLiked,
                          'top_likers': a.topLikers,
                        })
                    .toList(),
              }),
              cachedAt: DateTime.now(),
            ),
          );
      yield fresh;
    } catch (e) {
      _log.w('team feed fetch failed: $e');
      if (cacheRow == null) rethrow;
    }
  }

  Future<MileageLeaderboard> getMileage(String teamId, {String period = 'month'}) {
    return _api.getTeamMileage(teamId, period: period);
  }

  Future<MyTeamsResponse> getMyTeams() => _api.getMyTeams();

  Future<Team> getTeam(String teamId) => _api.getTeam(teamId);

  /// Toggle like — caller flips local state optimistically before calling.
  /// Returns the server-reported like count from the response, or null
  /// if missing.
  Future<int?> like(String teamId, String userId, String labelId) async {
    final resp = await _api.likeActivity(teamId, userId, labelId);
    return (resp['like_count'] as num?)?.toInt();
  }

  Future<int?> unlike(String teamId, String userId, String labelId) async {
    final resp = await _api.unlikeActivity(teamId, userId, labelId);
    return (resp['like_count'] as num?)?.toInt();
  }
}

final teamsRepositoryProvider = Provider<TeamsRepository>((ref) {
  return TeamsRepository(
    ref.watch(strideApiProvider),
    ref.watch(databaseProvider),
  );
});
