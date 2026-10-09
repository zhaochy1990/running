import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../features_v2/activity/models/activity_detail.dart';
import '../../features_v2/activity/models/timeseries_data.dart';
import '../../features_v2/onboarding/models/onboarding_defaults.dart';
import '../models/activity.dart';
import '../models/health.dart';
import '../models/plan.dart';
import '../models/weekly_plan.dart';
import '../models/profile.dart';

/// Hand-written API client for STRIDE backend `/api/*`.
///
/// Per plan O3 "hand-write everything" — no Retrofit codegen, just thin
/// methods over a shared [Dio]. Each method:
///   - calls the backend with typed path/query params
///   - parses the response into a typed model
///   - throws [ApiException] on non-2xx status
class StrideApi {
  StrideApi(this._dio);

  static const syncReceiveTimeout = Duration(minutes: 5);

  final Dio _dio;

  // ── Profile ────────────────────────────────────────────────────────────
  Future<MyProfile> getMyProfile() async {
    final json = await _get<Map<String, dynamic>>('/api/users/me/profile');
    return MyProfile.fromJson(json);
  }

  /// Partial profile update. Backend merges non-null fields into the
  /// existing `profile.json` (see `src/stride_server/routes/profile.py`
  /// `ProfilePatch`). Returns the merged profile map.
  ///
  /// Schema note: backend's `ProfilePatch` expects `sex` (male/female/other)
  /// and `dob` (ISO date) rather than the plan's draft `gender`/`birth_year`
  /// names. We translate at this boundary.
  Future<Map<String, dynamic>> patchProfile({
    String? sex,
    String? dob,
    double? heightCm,
    double? weightKg,
    String? displayName,
  }) async {
    final body = <String, dynamic>{
      'sex': ?sex,
      'dob': ?dob,
      'height_cm': ?heightCm,
      'weight_kg': ?weightKg,
      'display_name': ?displayName,
    };
    return _patch<Map<String, dynamic>>('/api/users/me/profile', body: body);
  }

  /// Fetch onboarding-default RHR / MaxHR suggestions for B4. Backend
  /// derives RHR from recent `daily_health` and MaxHR from 220-age formula.
  Future<OnboardingDefaults> getOnboardingDefaults() async {
    final json = await _get<Map<String, dynamic>>(
      '/api/users/me/onboarding/defaults',
    );
    return OnboardingDefaults.fromJson(json);
  }

  /// Mark onboarding complete & kick off a lightweight background sync.
  /// Returns the raw body (e.g. `{state: "running"|"already-complete"}`).
  Future<Map<String, dynamic>> completeOnboarding() async {
    return _post<Map<String, dynamic>>('/api/users/me/onboarding/complete');
  }

  // ── Activities ─────────────────────────────────────────────────────────
  Future<List<Activity>> listActivities(
    String user, {
    int? limit,
    int? offset,
    String? from,
    String? to,
  }) async {
    // Backend returns {total, offset, limit, activities: [...]} —
    // unpack the activities field rather than casting the wrapper.
    final json = await _get<Map<String, dynamic>>(
      '/api/$user/activities',
      query: {'limit': ?limit, 'offset': ?offset, 'from': ?from, 'to': ?to},
    );
    final list = (json['activities'] as List? ?? const [])
        .cast<Map<String, dynamic>>();
    return list.map(Activity.fromJson).toList(growable: false);
  }

  Future<ActivityDetailResponse> getActivity(
    String user,
    String labelId,
  ) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/$user/activities/$labelId',
    );
    return ActivityDetailResponse.fromJson(json);
  }

  /// Fetch activity detail without timeseries (mobile default).
  Future<ActivityDetailV2> getActivityDetail(
    String user,
    String labelId, {
    bool includeTimeseries = false,
  }) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/$user/activities/$labelId',
      query: includeTimeseries ? {'include': 'timeseries'} : null,
    );
    return ActivityDetailV2.fromJson(json);
  }

  /// Fetch downsampled timeseries for a single activity (lazy-load).
  Future<TimeseriesData> getActivityTimeseries(
    String user,
    String labelId, {
    int downsample = 300,
    Set<String>? fields,
  }) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/$user/activities/$labelId/timeseries',
      query: {
        'downsample': downsample,
        if (fields != null && fields.isNotEmpty) 'fields': fields.join(','),
      },
    );
    return TimeseriesData.fromJson(json);
  }

  // ── Plan ───────────────────────────────────────────────────────────────

  /// Lightweight week index — used to find the folder for today's week
  /// without paying for full plan/feedback bodies.
  Future<List<WeekIndexEntry>> listWeeks(String user) async {
    final json = await _get<Map<String, dynamic>>('/api/$user/weeks');
    final raw = (json['weeks'] as List? ?? const [])
        .cast<Map<String, dynamic>>();
    return raw.map(WeekIndexEntry.fromJson).toList(growable: false);
  }

  /// Full week payload — plan markdown + feedback + activity list. We only
  /// surface the markdown body in v1; the rest is read by other screens.
  Future<WeekDetail> getWeek(String user, String folder) async {
    final json = await _get<Map<String, dynamic>>('/api/$user/weeks/$folder');
    return WeekDetail.fromJson(json);
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

  /// Raw ability/current response for the E4 radar screen.
  /// Returns the full JSON map so [AbilitySnapshot] can parse l3_dimensions.
  Future<Map<String, dynamic>> getAbilityCurrentRaw(String user) async {
    return _get<Map<String, dynamic>>('/api/$user/ability/current');
  }

  /// Race predictions — E5 screen.
  Future<Map<String, dynamic>> getRacePredictions(String user) async {
    return _get<Map<String, dynamic>>('/api/$user/race-predictions');
  }

  /// Historical race predictions for trend chart.
  Future<Map<String, dynamic>> getRacePredictionsHistory(
    String user, {
    int days = 180,
  }) async {
    return _get<Map<String, dynamic>>(
      '/api/$user/race-predictions/history',
      query: {'days': days},
    );
  }

  /// Personal bests — E6 screen.
  Future<Map<String, dynamic>> getPbs(String user) async {
    return _get<Map<String, dynamic>>('/api/$user/pbs');
  }

  // ── Onboarding ─────────────────────────────────────────────────────────
  /// Bind a COROS watch by exchanging email/password via the registered
  /// adapter. `region` is forwarded as a best-effort hint; the current
  /// backend endpoint may ignore it (auto-detected at login).
  ///
  /// Throws [ApiException] on auth/network failure (backend collapses
  /// auth errors to 400 with a generic message to avoid enumeration).
  Future<Map<String, dynamic>> linkCoros({
    required String email,
    required String password,
    String? region,
  }) async {
    return _post<Map<String, dynamic>>(
      '/api/users/me/coros/login',
      body: {'email': email, 'password': password, 'region': ?region},
    );
  }

  /// Kick off the lightweight onboarding sync (health-only). The backend
  /// returns immediately with `{state: 'running'|'already-complete'}`;
  /// the client polls [getOnboardingSyncStatus] for progress.
  Future<Map<String, dynamic>> startOnboardingSync() async {
    return _post<Map<String, dynamic>>('/api/users/me/onboarding/complete');
  }

  /// Poll the onboarding sync state. Returns the raw payload — fields:
  ///   state    : 'running'|'done'|'error'|null
  ///   progress : { phase, percent, message, synced_activities?,
  ///               synced_health?, started_at, updated_at, ... }
  ///   error    : optional message when state == 'error'
  Future<Map<String, dynamic>> getOnboardingSyncStatus() async {
    return _get<Map<String, dynamic>>('/api/users/me/sync-status');
  }

  // ── Writes ─────────────────────────────────────────────────────────────
  Future<void> triggerSync(String user, {bool full = false}) async {
    final response = await _post<Map<String, dynamic>>(
      '/api/$user/sync',
      query: {if (full) 'full': true},
      options: Options(receiveTimeout: syncReceiveTimeout),
    );
    final success = response['success'];
    if (success is! bool) {
      throw const ApiException(200, 'Invalid sync response');
    }
    if (!success) {
      final error = response['error'];
      throw ApiException(
        200,
        error is String && error.isNotEmpty ? error : 'Sync failed',
        response,
      );
    }
  }

  Future<Map<String, dynamic>> pushPlannedSession(
    String user,
    String date,
    int sessionIndex, {
    String? targetDate,
  }) async {
    return _post<Map<String, dynamic>>(
      '/api/$user/plan/sessions/$date/$sessionIndex/push',
      query: {'target_date': ?targetDate},
    );
  }

  /// Structured weekly plan — GET /api/{user}/plan/weeks/{weekName}.
  /// weekName 格式 `YYYY-MM-DD_MM-DD`（上海周一起始），见 [WeeklyPlanDetail].
  Future<WeeklyPlanDetail> getWeeklyPlan(String user, String weekName) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/$user/plan/weeks/$weekName',
    );
    return WeeklyPlanDetail.fromJson(json);
  }

  /// Unbind the currently-linked watch. Calls `DELETE /api/users/me/watch`.
  Future<void> unbindWatch() async {
    await _delete<Map<String, dynamic>>('/api/users/me/watch');
  }

  // ── Coach chat ─────────────────────────────────────────────────────────
  /// Send a message to the orchestrator coach brain.
  /// `POST /api/users/me/coach/chat` — body
  /// `{session_id, message, client_turn_id}`. The server
  /// derives the thread key as `{user}:coach:{session_id}` and maintains
  /// conversation history per session. Returns one orchestrated turn:
  /// `reply` (the user-facing answer), an optional `clarification` (when the
  /// coach needs more info), the echoed `session_id`, and the `thread_id`.
  Future<CoachChatReply> postCoachChat({
    required String sessionId,
    required String message,
    required String clientTurnId,
  }) async {
    final r = await _post<Map<String, dynamic>>(
      '/api/users/me/coach/chat',
      body: {
        'session_id': sessionId,
        'message': message,
        'client_turn_id': clientTurnId,
      },
    );
    return CoachChatReply(
      sessionId: r['session_id'] as String? ?? sessionId,
      threadId: r['thread_id'] as String? ?? '',
      reply: r['reply'] as String? ?? '',
      clarification: r['clarification'] as String?,
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────
  Future<T> _get<T>(String path, {Map<String, dynamic>? query}) async {
    final res = await _dio.get<T>(path, queryParameters: query);
    return _unpack<T>(res);
  }

  Future<T> _post<T>(
    String path, {
    Map<String, dynamic>? query,
    Object? body,
    Options? options,
  }) async {
    final res = await _dio.post<T>(
      path,
      queryParameters: query,
      data: body,
      options: options,
    );
    return _unpack<T>(res);
  }

  Future<T> _delete<T>(String path) async {
    final res = await _dio.delete<T>(path);
    return _unpack<T>(res);
  }


  Future<T> _patch<T>(String path, {Object? body}) async {
    final res = await _dio.patch<T>(path, data: body);
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

/// One orchestrated coach turn — reply text + optional clarification.
class CoachChatReply {
  const CoachChatReply({
    required this.sessionId,
    required this.threadId,
    required this.reply,
    this.clarification,
  });

  final String sessionId;
  final String threadId;
  final String reply;
  final String? clarification;
}
