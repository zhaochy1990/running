import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../features_v2/activity/models/activity_detail.dart';
import '../../features_v2/activity/models/timeseries_data.dart';
import '../../features_v2/feedback/models/activity_feedback.dart';
import '../../features_v2/home/models/home_data.dart';
import '../../features_v2/nutrition/models/daily_advice.dart';
import '../../features_v2/nutrition/models/meals_daily.dart';
import '../../features_v2/nutrition/models/nutrition_prefs.dart';
import '../../features_v2/onboarding/models/onboarding_defaults.dart';
import '../../features_v2/review/models/week_review.dart';
import '../../features_v2/training_plan/models/master_plan.dart';
import '../../features_v2/training_plan/models/running_profile.dart';
import '../../features_v2/training_plan/models/training_goal.dart';
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
      body: {'week_start': weekStart, 'source': source},
    );
    return GeneratedWeek.fromJson(resp);
  }

  Future<PlanTodayResponse> getPlanToday(String user) async {
    final json = await _get<Map<String, dynamic>>('/api/$user/plan/today');
    return PlanTodayResponse.fromJson(json);
  }

  Future<PlanDaysResponse> getPlanDays(
    String user,
    String from,
    String to,
  ) async {
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

  Future<MileageLeaderboard> getTeamMileage(
    String teamId, {
    String period = 'month',
  }) async {
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
    final json = await _get<Map<String, dynamic>>(
      '/api/users/me/notification-prefs',
    );
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
      body: {'rpe': rpe, 'mood_tags': moodTags, 'note': note},
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

  // ── Weekly plan adjustment (orchestrator coach) ────────────────────────

  /// Derive a stable, server-accepted session id for a week's adjustment chat.
  /// The orchestrator constrains `session_id` to `[A-Za-z0-9_-]` (no ':'), but a
  /// folder like `2026-06-22_06-28(W8)` carries parens — sanitize so reopening
  /// the same week resumes the same server-threaded conversation.
  static String weekChatSessionId(String folder) {
    final sanitized = folder
        .replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '-')
        .replaceAll(RegExp(r'-{2,}'), '-')
        .replaceAll(RegExp(r'-+$'), '');
    return 'week-$sanitized';
  }

  /// Send a weekly-adjustment message through the orchestrator coach brain.
  /// `POST /api/users/me/coach/chat`. The `weekly_plan` specialist may attach a
  /// proposed `PlanDiff` (Pattern Y) which rides back in `proposals[]`; we
  /// surface the first one. Returns the user-facing `reply`, an optional
  /// `clarification`, and the proposed diff (or null for a plain Q&A turn).
  Future<
    ({
      String reply,
      String? clarification,
      Map<String, dynamic>? diff,
      String baseRevision,
    })
  >
  sendWeeklyAdjustMessage({
    required String folder,
    required String message,
    required String clientTurnId,
  }) async {
    final sessionId = weekChatSessionId(folder);
    final r = await _post<Map<String, dynamic>>(
      '/api/users/me/coach/chat',
      body: {
        'session_id': sessionId,
        'message': message,
        'client_turn_id': clientTurnId,
        'target': {'kind': 'week', 'folder': folder},
      },
    );
    final proposals = (r['proposals'] as List?) ?? const [];
    Map<String, dynamic>? diff;
    var baseRevision = '';
    for (final p in proposals) {
      if (p is Map<String, dynamic> &&
          p['specialist_id'] == 'weekly_plan' &&
          p['proposal'] is Map<String, dynamic>) {
        diff = p['proposal'] as Map<String, dynamic>;
        baseRevision = p['base_revision'] as String? ?? '';
        break;
      }
    }
    return (
      reply: r['reply'] as String? ?? '',
      clarification: r['clarification'] as String?,
      diff: diff,
      baseRevision: baseRevision,
    );
  }

  /// Apply the accepted ops of a coach-proposed week `PlanDiff`. The orchestrator
  /// is stateless, so the *whole* diff is sent back (Pattern Y).
  /// `POST /api/users/me/coach/plan/{folder}/apply`.
  Future<Map<String, dynamic>> applyWeeklyAdjustDiff({
    required String folder,
    required Map<String, dynamic> diff,
    required List<String> acceptedOpIds,
    required String baseRevision,
  }) async {
    return _post<Map<String, dynamic>>(
      '/api/users/me/coach/plan/$folder/apply',
      body: {
        'session_id': weekChatSessionId(folder),
        'diff': diff,
        'accepted_op_ids': acceptedOpIds,
        'base_revision': baseRevision,
      },
    );
  }

  // ── Full sync (C3 history sync) ────────────────────────────────────────
  /// Trigger a full 3-year history sync (POST /api/users/me/full-sync).
  /// Returns the raw response (e.g. `{state: "running"}`).
  /// Callers should ignore 409 (already running) — handled by history_sync_provider.
  Future<Map<String, dynamic>> startFullSync() async {
    return _post<Map<String, dynamic>>('/api/users/me/full-sync', body: {});
  }

  /// Poll the full sync status.
  Future<Map<String, dynamic>> getFullSyncStatus() async {
    return _get<Map<String, dynamic>>('/api/users/me/full-sync/status');
  }

  // ── Training Goal (M3 C1) ──────────────────────────────────────────────
  Future<TrainingGoal?> getTrainingGoal() async {
    try {
      final r = await _get<Map<String, dynamic>>('/api/users/me/training-goal');
      return TrainingGoal.fromJson(r);
    } on DioException catch (e) {
      if (e.response?.statusCode == 404) return null;
      rethrow;
    }
  }

  Future<TrainingGoal> postTrainingGoal(Map<String, dynamic> body) async {
    final r = await _post<Map<String, dynamic>>(
      '/api/users/me/training-goal',
      body: body,
    );
    return TrainingGoal.fromJson(r);
  }

  Future<TrainingGoal> putTrainingGoal(Map<String, dynamic> body) async {
    final r = await _put<Map<String, dynamic>>(
      '/api/users/me/training-goal',
      body: body,
    );
    return TrainingGoal.fromJson(r);
  }

  // ── Running Profile (M3 C2) ────────────────────────────────────────────
  Future<RunningProfile?> getRunningProfile() async {
    try {
      final r = await _get<Map<String, dynamic>>(
        '/api/users/me/running-profile',
      );
      return RunningProfile.fromJson(r);
    } on DioException catch (e) {
      if (e.response?.statusCode == 404) return null;
      rethrow;
    }
  }

  Future<RunningProfile> postRunningProfile(Map<String, dynamic> body) async {
    final r = await _post<Map<String, dynamic>>(
      '/api/users/me/running-profile',
      body: body,
    );
    return RunningProfile.fromJson(r);
  }

  // ── Master Plan (M3 C4/C5) ─────────────────────────────────────────────
  Future<Map<String, dynamic>> postMasterPlanGenerate({
    String? goalId,
    String? profileId,
  }) async {
    final body = <String, dynamic>{};
    if (goalId != null) body['goal_id'] = goalId;
    if (profileId != null) body['profile_id'] = profileId;
    return _post<Map<String, dynamic>>(
      '/api/users/me/master-plan/generate',
      body: body,
    );
  }

  Future<Map<String, dynamic>> getMasterPlanJobStatus(String jobId) async {
    return _get<Map<String, dynamic>>('/api/users/me/master-plan/jobs/$jobId');
  }

  Future<Map<String, dynamic>> getMasterPlan(String planId) async {
    return _get<Map<String, dynamic>>('/api/users/me/master-plan/$planId');
  }

  Future<Map<String, dynamic>> sendMasterPlanReviewMessage({
    required String planId,
    required String message,
    List<Map<String, dynamic>>? history,
  }) async {
    return _post<Map<String, dynamic>>(
      '/api/users/me/master-plan/$planId/review/messages',
      body: {'message': message, 'history': ?history},
    );
  }

  Future<Map<String, dynamic>> applyMasterPlanReviewDiff({
    required String planId,
    required Map<String, dynamic> diff,
    required List<String> acceptedOpIds,
    String? changeReason,
  }) async {
    return _post<Map<String, dynamic>>(
      '/api/users/me/master-plan/$planId/review/apply',
      body: {
        'diff': diff,
        'accepted_op_ids': acceptedOpIds,
        'change_reason': ?changeReason,
      },
    );
  }

  Future<Map<String, dynamic>> confirmMasterPlan(String planId) async {
    return _post<Map<String, dynamic>>(
      '/api/users/me/master-plan/$planId/confirm',
      body: {},
    );
  }

  /// GET /api/users/me/master-plan/current — active plan with derived fields.
  Future<MasterPlan?> getCurrentMasterPlan() async {
    try {
      final r = await _get<Map<String, dynamic>>(
        '/api/users/me/master-plan/current',
      );
      return MasterPlan.fromJson(r);
    } on DioException catch (e) {
      if (e.response?.statusCode == 404) return null;
      rethrow;
    }
  }

  // ── Master Plan adjust (C7) ────────────────────────────────────────────

  /// POST /api/users/me/master-plan/{planId}/adjust/messages
  Future<Map<String, dynamic>> sendMasterPlanAdjustMessage({
    required String planId,
    required String message,
    List<Map<String, dynamic>>? history,
  }) async {
    return _post<Map<String, dynamic>>(
      '/api/users/me/master-plan/$planId/adjust/messages',
      body: {'message': message, 'history': ?history},
    );
  }

  /// POST /api/users/me/master-plan/{planId}/adjust/apply
  Future<Map<String, dynamic>> applyMasterPlanAdjustDiff({
    required String planId,
    required Map<String, dynamic> diff,
    required List<String> acceptedOpIds,
    String? changeReason,
  }) async {
    return _post<Map<String, dynamic>>(
      '/api/users/me/master-plan/$planId/adjust/apply',
      body: {
        'diff': diff,
        'accepted_op_ids': acceptedOpIds,
        'change_reason': ?changeReason,
      },
    );
  }

  // ── Master Plan versions (C8) ──────────────────────────────────────────

  /// GET /api/users/me/master-plan/{planId}/versions
  Future<List<MasterPlanVersionSummary>> listMasterPlanVersions(
    String planId,
  ) async {
    final r = await _get<Map<String, dynamic>>(
      '/api/users/me/master-plan/$planId/versions',
    );
    final list = (r['versions'] as List? ?? const [])
        .cast<Map<String, dynamic>>();
    return list.map(MasterPlanVersionSummary.fromJson).toList(growable: false);
  }

  /// GET /api/users/me/master-plan/{planId}/versions/{version}
  Future<Map<String, dynamic>> getMasterPlanVersion(
    String planId,
    int version,
  ) async {
    return _get<Map<String, dynamic>>(
      '/api/users/me/master-plan/$planId/versions/$version',
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

  // ── Nutrition (M5) ────────────────────────────────────────────────────────

  /// GET /api/users/me/nutrition-prefs — returns null on 404.
  Future<NutritionPrefs?> getNutritionPrefs() async {
    try {
      final r = await _get<Map<String, dynamic>>(
        '/api/users/me/nutrition-prefs',
      );
      return NutritionPrefs.fromJson(r);
    } on DioException catch (e) {
      if (e.response?.statusCode == 404) return null;
      rethrow;
    }
  }

  /// PUT /api/users/me/nutrition-prefs
  Future<NutritionPrefs> putNutritionPrefs(Map<String, dynamic> body) async {
    final r = await _put<Map<String, dynamic>>(
      '/api/users/me/nutrition-prefs',
      body: body,
    );
    return NutritionPrefs.fromJson(r);
  }

  /// GET /api/{user}/nutrition/daily — returns null on 404 (no prefs).
  Future<DailyAdvice?> getDailyNutrition(String user, {String? date}) async {
    try {
      final r = await _get<Map<String, dynamic>>(
        '/api/$user/nutrition/daily',
        query: {'date': ?date},
      );
      return DailyAdvice.fromJson(r);
    } on DioException catch (e) {
      if (e.response?.statusCode == 404) return null;
      rethrow;
    }
  }

  /// GET /api/{user}/nutrition/meals — returns null on 404.
  Future<MealsDaily?> getDailyMeals(String user, {String? date}) async {
    try {
      final r = await _get<Map<String, dynamic>>(
        '/api/$user/nutrition/meals',
        query: {'date': ?date},
      );
      return MealsDaily.fromJson(r);
    } on DioException catch (e) {
      if (e.response?.statusCode == 404) return null;
      rethrow;
    }
  }

  /// POST /api/{user}/nutrition/meals
  Future<Map<String, dynamic>> postMeal(
    String user,
    Map<String, dynamic> body,
  ) async {
    return _post<Map<String, dynamic>>(
      '/api/$user/nutrition/meals',
      body: body,
    );
  }

  // ── Coach chat ─────────────────────────────────────────────────────────
  /// Send a message to the orchestrator coach brain.
  /// `POST /api/users/me/coach/chat` — body
  /// `{session_id, message, client_turn_id}`. The server
  /// derives the thread key as `{user}:coach:{session_id}` and maintains
  /// conversation history per session. Returns one orchestrated turn:
  /// `reply` (the user-facing answer), an optional `clarification` (when the
  /// coach needs more info), the echoed `session_id`, and the `thread_id`.
  Future<
    ({
      String sessionId,
      String threadId,
      String reply,
      String? clarification,
      List<Map<String, dynamic>> proposals,
    })
  >
  postCoachChat({
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
    final proposals = <Map<String, dynamic>>[];
    for (final item in (r['proposals'] as List? ?? const [])) {
      if (item is Map<String, dynamic>) proposals.add(item);
    }
    return (
      sessionId: r['session_id'] as String? ?? sessionId,
      threadId: r['thread_id'] as String? ?? '',
      reply: r['reply'] as String? ?? '',
      clarification: r['clarification'] as String?,
      proposals: proposals,
    );
  }

  /// Apply every accepted operation in a stateless Coach season proposal.
  Future<Map<String, dynamic>> applyCoachMasterPlanDiff({
    required String sessionId,
    required String planId,
    required Map<String, dynamic> diff,
    required List<String> acceptedOpIds,
    required String baseRevision,
    String changeReason = 'coach adjustment',
  }) async {
    return _post<Map<String, dynamic>>(
      '/api/users/me/coach/master-plan/$planId/apply',
      body: {
        'session_id': sessionId,
        'diff': diff,
        'accepted_op_ids': acceptedOpIds,
        'change_reason': changeReason,
        'base_revision': baseRevision,
      },
    );
  }

  /// Record that a surfaced proposal was abandoned on its originating session.
  Future<void> abandonCoachProposal({
    required String sessionId,
    required Map<String, dynamic> target,
    String summary = '用户放弃了本次调整方案',
  }) async {
    await _post<Map<String, dynamic>>(
      '/api/users/me/coach/proposals/abandon',
      body: {'session_id': sessionId, 'target': target, 'summary': summary},
    );
  }

  /// Fetch the persisted history for a coach thread.
  /// `GET /api/users/me/coach/threads/{threadId}/messages`. Returns a flat list
  /// of (role, text) — assistant turns flatten their renderable text parts.
  Future<List<({String role, String text})>> getCoachThread(
    String threadId,
  ) async {
    final r = await _get<Map<String, dynamic>>(
      '/api/users/me/coach/threads/$threadId/messages',
    );
    final raw = (r['messages'] as List? ?? const [])
        .cast<Map<String, dynamic>>();
    final out = <({String role, String text})>[];
    for (final m in raw) {
      final role = m['role'] as String? ?? 'assistant';
      // Skip tool turns — not user-facing in the chat transcript.
      if (role == 'tool') continue;
      final content = (m['content'] as String?) ?? '';
      final eventSummary = (m['summary'] as String?) ?? '';
      final partsText = _textFromParts(m['parts']);
      final text = content.isNotEmpty
          ? content
          : (eventSummary.isNotEmpty ? eventSummary : partsText);
      if (text.trim().isEmpty) continue;
      out.add((role: role, text: text));
    }
    return out;
  }

  /// Extract renderable text from a list of AssistantPart maps. Each part is
  /// `{kind: text|reasoning|refusal|tool_meta, text?: ...}`; we keep `text` and
  /// `refusal` kinds and join them. Reasoning / tool_meta are dropped.
  static String _textFromParts(Object? parts) {
    if (parts is! List) return '';
    final buf = <String>[];
    for (final p in parts) {
      if (p is! Map) continue;
      final kind = p['kind'] as String?;
      if (kind == 'reasoning' || kind == 'tool_meta') continue;
      final t = (p['text'] as String?) ?? (p['content'] as String?);
      if (t != null && t.trim().isNotEmpty) buf.add(t);
    }
    return buf.join('\n\n');
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
  factory GeneratedWeek.fromJson(Map<String, dynamic> json) {
    return GeneratedWeek(
      folder: json['folder'] as String,
      sessionsCount: (json['sessions_count'] as num?)?.toInt() ?? 0,
      totalDistanceKm: (json['total_distance_km'] as num?)?.toDouble() ?? 0.0,
    );
  }
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
}
