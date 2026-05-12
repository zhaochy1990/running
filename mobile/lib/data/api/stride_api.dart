import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../features_v2/activity/models/activity_detail.dart';
import '../../features_v2/activity/models/timeseries_data.dart';
import '../../features_v2/feedback/models/activity_feedback.dart';
import '../../features_v2/home/models/home_data.dart';
import '../../features_v2/onboarding/models/onboarding_defaults.dart';
import '../../features_v2/review/models/week_review.dart';
import '../models/activity.dart';
import '../models/health.dart';
import '../models/notifications.dart';
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
      if (sex != null) 'sex': sex,
      if (dob != null) 'dob': dob,
      if (heightCm != null) 'height_cm': heightCm,
      if (weightKg != null) 'weight_kg': weightKg,
      if (displayName != null) 'display_name': displayName,
    };
    return _patch<Map<String, dynamic>>(
      '/api/users/me/profile',
      body: body,
    );
  }

  /// Fetch onboarding-default RHR / MaxHR suggestions for B4. Backend
  /// derives RHR from recent `daily_health` and MaxHR from 220-age formula.
  Future<OnboardingDefaults> getOnboardingDefaults() async {
    final json =
        await _get<Map<String, dynamic>>('/api/users/me/onboarding/defaults');
    return OnboardingDefaults.fromJson(json);
  }

  /// Mark onboarding complete & kick off a lightweight background sync.
  /// Returns the raw body (e.g. `{state: "running"|"already-complete"}`).
  Future<Map<String, dynamic>> completeOnboarding() async {
    return _post<Map<String, dynamic>>('/api/users/me/onboarding/complete');
  }

  Future<MyTeamsResponse> getMyTeams() async {
    final json = await _get<Map<String, dynamic>>('/api/users/me/teams');
    return MyTeamsResponse.fromJson(json);
  }

  // ── Home ───────────────────────────────────────────────────────────────
  /// Aggregated home screen data (status ring, recent activities, stats).
  Future<HomeData> getHome(String user, {int recentDays = 7}) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/$user/home',
      query: {'recent_days': recentDays},
    );
    return HomeData.fromJson(json);
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
      query: {
        'limit': ?limit,
        'offset': ?offset,
        'from': ?from,
        'to': ?to,
      },
    );
    final list = (json['activities'] as List? ?? const [])
        .cast<Map<String, dynamic>>();
    return list.map(Activity.fromJson).toList(growable: false);
  }

  Future<ActivityDetailResponse> getActivity(String user, String labelId) async {
    final json = await _get<Map<String, dynamic>>('/api/$user/activities/$labelId');
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

  /// Trigger commentary regeneration for an activity.
  Future<void> regenerateCommentary(String user, String labelId) async {
    await _post<Map<String, dynamic>>(
      '/api/$user/activities/$labelId/commentary/regenerate',
    );
  }

  /// Team-scoped activity detail — used when viewing a teammate's activity.
  /// Authorizes via team membership instead of path-user match, so the
  /// caller doesn't get a 403 for someone else's activity.
  Future<ActivityDetailResponse> getTeamActivity(
    String teamId,
    String userId,
    String labelId,
  ) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/teams/$teamId/activities/$userId/$labelId',
    );
    return ActivityDetailResponse.fromJson(json);
  }

  // ── Plan ───────────────────────────────────────────────────────────────

  /// Generate a weekly plan via the rule-based engine (T21 endpoint).
  ///
  /// Returns a [GeneratedWeek] with the folder + summary counts.
  /// Throws [ApiException] with statusCode 409 when the week already exists
  /// and [force] is false — callers should offer the user an override dialog.
  Future<GeneratedWeek> generateWeek(
    String user, {
    required String weekStart,
    String source = 'manual',
    bool force = false,
  }) async {
    final qs = force ? '?force=true' : '';
    final resp = await _post<Map<String, dynamic>>(
      '/api/$user/plan/weeks/generate$qs',
      body: {
        'week_start': weekStart,
        'source': source,
      },
    );
    return GeneratedWeek.fromJson(resp);
  }

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

  /// Overall TRAINING_PLAN.md + phase timeline.
  Future<TrainingPlanResponse> getTrainingPlan(String user) async {
    final json = await _get<Map<String, dynamic>>('/api/$user/training-plan');
    return TrainingPlanResponse.fromJson(json);
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
      body: {
        'email': email,
        'password': password,
        if (region != null) 'region': region,
      },
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

  // ── Notifications ──────────────────────────────────────────────────────
  Future<void> registerDevice({
    required String registrationId,
    required String platform,
    String? appVersion,
  }) async {
    await _post<Map<String, dynamic>>(
      '/api/users/me/devices',
      body: {
        'registration_id': registrationId,
        'platform': platform,
        'app_version': ?appVersion,
      },
    );
  }

  Future<void> unregisterDevice(String registrationId) async {
    await _delete<Map<String, dynamic>>(
      '/api/users/me/devices/$registrationId',
    );
  }

  /// Unbind the currently-linked watch. Calls `DELETE /api/users/me/watch`.
  Future<void> unbindWatch() async {
    await _delete<Map<String, dynamic>>('/api/users/me/watch');
  }

  Future<NotificationPrefs> getNotificationPrefs() async {
    final json =
        await _get<Map<String, dynamic>>('/api/users/me/notification-prefs');
    return NotificationPrefs.fromJson(json);
  }

  Future<NotificationPrefs> patchNotificationPrefs({
    bool? likesEnabled,
    bool? planReminderEnabled,
    String? planReminderTime,
  }) async {
    final json = await _patch<Map<String, dynamic>>(
      '/api/users/me/notification-prefs',
      body: {
        'likes_enabled': ?likesEnabled,
        'plan_reminder_enabled': ?planReminderEnabled,
        'plan_reminder_time': ?planReminderTime,
      },
    );
    return NotificationPrefs.fromJson(json);
  }

  // ── Feedback ───────────────────────────────────────────────────────────

  /// Submit (upsert) post-activity feedback.
  /// Returns the persisted [ActivityFeedback].
  Future<ActivityFeedback> putActivityFeedback({
    required String userId,
    required String labelId,
    required int rpe,
    required List<String> moodTags,
    String? note,
  }) async {
    final json = await _put<Map<String, dynamic>>(
      '/api/$userId/activities/$labelId/feedback',
      body: {
        'rpe': rpe,
        'mood_tags': moodTags,
        'note': note,
      },
    );
    return ActivityFeedback.fromJson(json);
  }

  /// Read existing post-activity feedback. Returns a record with null fields
  /// when no feedback has been submitted yet (backend returns 200, not 404).
  Future<ActivityFeedback> getActivityFeedback(
    String userId,
    String labelId,
  ) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/$userId/activities/$labelId/feedback',
    );
    return ActivityFeedback.fromJson(json);
  }

  // ── Plan Chat ──────────────────────────────────────────────────────────

  /// Send a user message to the plan chat endpoint and return the raw
  /// response map (contains `ai_response` and optionally `diff`).
  Future<Map<String, dynamic>> sendPlanChatMessage({
    required String user,
    required String folder,
    required String message,
    List<Map<String, dynamic>>? history,
  }) async {
    return _post<Map<String, dynamic>>(
      '/api/$user/plan/$folder/chat/messages',
      body: {
        'message': message,
        if (history != null) 'history': history,
      },
    );
  }

  /// Apply accepted diff ops from a pending plan chat diff.
  Future<Map<String, dynamic>> applyPlanChatDiff({
    required String user,
    required String folder,
    required String diffId,
    required List<String> acceptedOpIds,
  }) async {
    return _post<Map<String, dynamic>>(
      '/api/$user/plan/$folder/chat/apply',
      body: {
        'diff_id': diffId,
        'accepted_op_ids': acceptedOpIds,
      },
    );
  }

  // ── Review ─────────────────────────────────────────────────────────────
  /// Fetch aggregated weekly review for D9 screen.
  Future<WeekReview> getWeekReview(String user, String folder) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/$user/weeks/$folder/review',
    );
    return WeekReview.fromJson(json);
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

  Future<T> _put<T>(String path, {Object? body}) async {
    final res = await _dio.put<T>(path, data: body);
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

// ── GeneratedWeek model ────────────────────────────────────────────────────────

/// Response model for `POST /api/{user}/plan/weeks/generate`.
///
/// Only the fields needed to navigate to the week detail screen are kept here;
/// the full plan is fetched by [WeekDetailScreen] once navigation completes.
class GeneratedWeek {
  const GeneratedWeek({
    required this.folder,
    required this.sessionsCount,
    required this.totalDistanceKm,
  });

  /// Backend folder key, e.g. "2026-05-11_05-17(W2)".
  final String folder;

  /// Number of sessions generated.
  final int sessionsCount;

  /// Total planned weekly distance in km.
  final double totalDistanceKm;

  factory GeneratedWeek.fromJson(Map<String, dynamic> json) {
    return GeneratedWeek(
      folder: json['folder'] as String,
      sessionsCount: (json['sessions_count'] as num?)?.toInt() ?? 0,
      totalDistanceKm: (json['total_distance_km'] as num?)?.toDouble() ?? 0.0,
    );
  }
}
