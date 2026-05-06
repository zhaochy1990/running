import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../models/activity.dart';
import '../models/health.dart';
import '../models/plan.dart';
import '../models/profile.dart';
import '../models/team.dart';

/// Hand-written API client for STRIDE backend `/api/*`.
///
/// Per plan O3 "hand-write everything" — no Retrofit codegen, just thin
/// methods over a shared [Dio]. Each method:
///   - calls the backend with typed path/query params
///   - parses the response into a typed model
///   - throws [ApiException] on non-2xx status
class StrideApi {
  StrideApi(this._dio);

  final Dio _dio;

  // ── Profile ────────────────────────────────────────────────────────────
  Future<MyProfile> getMyProfile() async {
    final json = await _get<Map<String, dynamic>>('/api/users/me/profile');
    return MyProfile.fromJson(json);
  }

  Future<MyTeamsResponse> getMyTeams() async {
    final json = await _get<Map<String, dynamic>>('/api/users/me/teams');
    return MyTeamsResponse.fromJson(json);
  }

  // ── Activities ─────────────────────────────────────────────────────────
  Future<List<Activity>> listActivities(
    String user, {
    int? limit,
    int? offset,
    String? from,
    String? to,
  }) async {
    final json = await _get<List<dynamic>>(
      '/api/$user/activities',
      query: {
        'limit': ?limit,
        'offset': ?offset,
        'from': ?from,
        'to': ?to,
      },
    );
    return json
        .cast<Map<String, dynamic>>()
        .map(Activity.fromJson)
        .toList(growable: false);
  }

  Future<ActivityDetailResponse> getActivity(String user, String labelId) async {
    final json = await _get<Map<String, dynamic>>('/api/$user/activities/$labelId');
    return ActivityDetailResponse.fromJson(json);
  }

  // ── Plan ───────────────────────────────────────────────────────────────
  Future<PlanTodayResponse> getPlanToday(String user) async {
    final json = await _get<Map<String, dynamic>>('/api/$user/plan/today');
    return PlanTodayResponse.fromJson(json);
  }

  Future<PlanDaysResponse> getPlanDays(String user, String from, String to) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/$user/plan/days',
      query: {'from': from, 'to': to},
    );
    return PlanDaysResponse.fromJson(json);
  }

  // ── Health ─────────────────────────────────────────────────────────────
  Future<HealthResponse> getHealth(String user, {int days = 30}) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/$user/health',
      query: {'days': days},
    );
    return HealthResponse.fromJson(json);
  }

  Future<PMCResponse> getPMC(String user, {int days = 90}) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/$user/pmc',
      query: {'days': days},
    );
    return PMCResponse.fromJson(json);
  }

  Future<AbilityCurrent> getAbilityCurrent(String user) async {
    final json = await _get<Map<String, dynamic>>('/api/$user/ability/current');
    return AbilityCurrent.fromJson(json);
  }

  // ── Teams ──────────────────────────────────────────────────────────────
  Future<Team> getTeam(String teamId) async {
    final json = await _get<Map<String, dynamic>>('/api/teams/$teamId');
    return Team.fromJson(json);
  }

  Future<TeamFeed> getTeamFeed(String teamId, {int days = 30}) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/teams/$teamId/feed',
      query: {'days': days},
    );
    return TeamFeed.fromJson(json);
  }

  Future<MileageLeaderboard> getTeamMileage(String teamId, {String period = 'month'}) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/teams/$teamId/mileage',
      query: {'period': period},
    );
    return MileageLeaderboard.fromJson(json);
  }

  // ── Writes ─────────────────────────────────────────────────────────────
  Future<void> triggerSync(String user, {bool full = false}) async {
    await _post<Map<String, dynamic>>(
      '/api/$user/sync',
      query: {if (full) 'full': true},
    );
  }

  Future<Map<String, dynamic>> pushPlannedSession(
    String user,
    String date,
    int sessionIndex,
  ) async {
    return _post<Map<String, dynamic>>(
      '/api/$user/plan/sessions/$date/$sessionIndex/push',
    );
  }

  Future<Map<String, dynamic>> likeActivity(
    String teamId,
    String userId,
    String labelId,
  ) async {
    return _post<Map<String, dynamic>>(
      '/api/teams/$teamId/activities/$userId/$labelId/likes',
    );
  }

  Future<Map<String, dynamic>> unlikeActivity(
    String teamId,
    String userId,
    String labelId,
  ) async {
    return _delete<Map<String, dynamic>>(
      '/api/teams/$teamId/activities/$userId/$labelId/likes',
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────
  Future<T> _get<T>(String path, {Map<String, dynamic>? query}) async {
    final res = await _dio.get<T>(path, queryParameters: query);
    return _unpack<T>(res);
  }

  Future<T> _post<T>(String path,
      {Map<String, dynamic>? query, Object? body}) async {
    final res = await _dio.post<T>(path, queryParameters: query, data: body);
    return _unpack<T>(res);
  }

  Future<T> _delete<T>(String path) async {
    final res = await _dio.delete<T>(path);
    return _unpack<T>(res);
  }

  T _unpack<T>(Response<T> res) {
    final code = res.statusCode ?? 0;
    if (code < 200 || code >= 300) {
      throw ApiException(code, res.statusMessage ?? 'HTTP $code', res.data);
    }
    final data = res.data;
    if (data == null) {
      throw ApiException(code, 'Empty response body');
    }
    return data;
  }
}

final strideApiProvider = Provider<StrideApi>((ref) {
  final client = ref.watch(apiClientProvider);
  return StrideApi(client.dio);
});
