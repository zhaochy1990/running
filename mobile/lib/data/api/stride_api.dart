import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/api/api_exception.dart';
import '../../features_v2/activity/models/activity_detail.dart';
import '../../features_v2/activity/models/timeseries_data.dart';
import '../../features_v2/race/models/race_models.dart';
import '../models/activity.dart';
import '../models/health.dart';
import '../models/plan.dart';
import '../models/weekly_plan.dart';
import '../models/pipeline.dart';
import '../models/profile.dart';
import '../models/watch.dart';

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

  /// 建立/覆盖数据面 profile（POST /api/users/me/profile，Go `profileInput`
  /// 的六个必填字段，与小程序 onboarding 资料步一致）。置 profile_ready。
  /// token 必须与 Go oneof 严格一致：中文标签直接 422，展示文案在 UI 层分离。
  Future<void> postProfile({
    required String displayName,
    required String dob,
    required String sex,
    required double heightCm,
    required double weightKg,
    required String runningAgeRange,
  }) async {
    await _post<Map<String, dynamic>>(
      '/api/users/me/profile',
      body: {
        'display_name': displayName,
        'dob': dob,
        'sex': sex,
        'height_cm': heightCm,
        'weight_kg': weightKg,
        'running_age_range': runningAgeRange,
      },
    );
  }

  /// Mark onboarding complete (空 body 幂等自愈，ADR 0013：资料步即 complete).
  /// Returns the raw body (e.g. `{state: "complete"|"already-complete"}`).
  Future<Map<String, dynamic>> completeOnboarding() async {
    return _post<Map<String, dynamic>>(
      '/api/users/me/onboarding/complete',
      body: <String, dynamic>{},
    );
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

  // ── Watch ───────────────────────────────────────────────────────────────
  /// Bind a watch provider (coros | garmin) via the unified multi-provider
  /// endpoint（替代 legacy /coros/login）。`region` applies to Garmin;
  /// backend collapses auth/network errors to 400 to avoid enumeration.
  Future<void> watchLogin({
    required String provider,
    required String email,
    required String password,
    String region = 'cn',
  }) async {
    await _post<Map<String, dynamic>>(
      '/api/users/me/watch/login',
      body: {
        'provider': provider,
        'email': email,
        'password': password,
        'region': region,
      },
    );
  }

  /// 当前用户手表绑定状态（GET /api/users/me/watch）。未绑定时 200、
  /// 字符串字段全 null、capabilities 空数组（Go watchInfoResponse）。
  Future<WatchInfo> getWatch() async {
    final json = await _get<Map<String, dynamic>>('/api/users/me/watch');
    return WatchInfo.fromJson(json);
  }

  /// Unbind the currently-linked watch. Calls `DELETE /api/users/me/watch`.
  Future<void> unbindWatch() async {
    await _delete<Map<String, dynamic>>('/api/users/me/watch');
  }

  // ── Sync pipelines（Go 活契约，stride-devops#418 端点表）───────────────
  /// Trigger a full/incremental sync pipeline. Go 只认 body `{mode}`、
  /// 响应 `{run_id, pipeline_name, deduplicated?}`（202 新建 / 200 deduplicated）；
  /// 带 [idempotencyKey] 时重复触发会被服务端去重并返回已有 run。
  Future<TriggerSyncResult> triggerSync(
    String user, {
    required bool full,
    String? idempotencyKey,
  }) async {
    final json = await _post<Map<String, dynamic>>(
      '/api/$user/sync',
      body: {'mode': full ? 'full' : 'incremental'},
      options: Options(
        receiveTimeout: syncReceiveTimeout,
        headers: {'Idempotency-Key': ?idempotencyKey},
      ),
    );
    final result = TriggerSyncResult.fromJson(json);
    if (result.runId.isEmpty) {
      throw ApiException(200, 'Invalid sync response', json);
    }
    return result;
  }

  /// Read one pipeline run（onboarding 轮询，2s 间隔）。
  Future<PipelineRun> getPipelineRun(String runId) async {
    final json = await _get<Map<String, dynamic>>('/api/pipelines/$runId');
    return PipelineRun.fromJson(json);
  }

  /// List the user's pipeline runs（新的在前），用于认领别端已起过的
  /// onboarding run（换设备 / 小程序、Web 先起过）。
  Future<List<PipelineRun>> listUserPipelines(String user) async {
    final json = await _get<Map<String, dynamic>>('/api/users/$user/pipelines');
    final list = (json['pipelines'] as List? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(PipelineRun.fromJson)
        .toList(growable: false);
    return list;
  }

  // ── Writes ─────────────────────────────────────────────────────────────
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

  // ── Race domain（赛事域四屏，Go 活契约零新增，stride-devops#466）─────────
  /// GET /api/race-calendar —— 已发布赛历分页。scope=all 拉整年。
  Future<RaceCalendarPage> getRaceCalendar({
    String? year,
    String? province,
    String? type,
    String scope = 'all',
    int page = 1,
    int perPage = 100,
  }) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/race-calendar',
      query: {
        'year': ?year,
        'province': ?province,
        'type': ?type,
        'scope': scope,
        'page': page,
        'per_page': perPage,
      },
    );
    return RaceCalendarPage.fromJson(json);
  }

  /// GET /api/race-calendar/{id} —— 详情（含 items/channels/city_content）。
  Future<RaceDetail> getRaceDetail(int raceId) async {
    final json = await _get<Map<String, dynamic>>('/api/race-calendar/$raceId');
    return RaceDetail.fromJson(json);
  }

  /// POST /api/users/me/race-favorites/{id}/toggle —— 返回切换后的收藏态。
  Future<bool> toggleRaceFavorite(int raceId) async {
    final json = await _post<Map<String, dynamic>>(
      '/api/users/me/race-favorites/$raceId/toggle',
    );
    return json['favorited'] as bool? ?? false;
  }

  /// GET /api/users/me/race-plans —— 我的参赛计划（lost 已被后端过滤）。
  Future<List<RacePlan>> getRacePlans() async {
    final json = await _get<Map<String, dynamic>>('/api/users/me/race-plans');
    return (json['plans'] as List? ?? const [])
        .cast<Map<String, dynamic>>()
        .map(RacePlan.fromJson)
        .toList(growable: false);
  }

  /// PUT /api/users/me/race-plans/{id} —— 报名选择器 upsert。
  /// hotel/transit 传 null = 缺省（后端保留存储值，勿误清另一项）。
  Future<void> putRacePlan(
    int raceId, {
    required String itemType,
    required String state,
    bool? hotel,
    bool? transit,
  }) async {
    await _put<Map<String, dynamic>>(
      '/api/users/me/race-plans/$raceId',
      body: {
        'item_type': itemType,
        'state': state,
        'hotel': ?hotel,
        'transit': ?transit,
      },
    );
  }

  /// DELETE /api/users/me/race-plans/{id} —— 取消追踪；404 按已取消收尾。
  Future<void> deleteRacePlan(int raceId) async {
    try {
      await _delete<Map<String, dynamic>>('/api/users/me/race-plans/$raceId');
    } on ApiException catch (e) {
      if (!e.isNotFound) rethrow;
    }
  }

  /// GET /api/users/me/race-strategies/{id} —— 该场赛事全部目标版本（最快在前）。
  Future<List<RaceStrategyVersion>> getRaceStrategies(int raceId) async {
    final json = await _get<Map<String, dynamic>>(
      '/api/users/me/race-strategies/$raceId',
    );
    return (json['strategies'] as List? ?? const [])
        .cast<Map<String, dynamic>>()
        .map(RaceStrategyVersion.fromJson)
        .toList(growable: false);
  }

  /// PUT /api/users/me/race-strategies/{id} —— 同 target 覆盖该版。
  /// content.target_finish_time 是版本键（服务端校验 H:MM:SS）。
  Future<void> putRaceStrategy(
    int raceId, {
    required String itemType,
    required Map<String, dynamic> content,
  }) async {
    await _put<Map<String, dynamic>>(
      '/api/users/me/race-strategies/$raceId',
      body: {'item_type': itemType, 'content': content},
    );
  }

  /// DELETE /api/users/me/race-strategies/{id}?target=H:MM:SS —— 删一个版本。
  Future<void> deleteRaceStrategy(int raceId, {required String target}) async {
    await _delete<Map<String, dynamic>>(
      '/api/users/me/race-strategies/$raceId',
      query: {'target': target},
    );
  }

  /// GET /api/{user}/races —— race detection 确认的比赛成绩（新→旧）。
  Future<List<UserRace>> getUserRaces(String user) async {
    final json = await _get<Map<String, dynamic>>('/api/$user/races');
    return (json['races'] as List? ?? const [])
        .cast<Map<String, dynamic>>()
        .map(UserRace.fromJson)
        .toList(growable: false);
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

  Future<T> _delete<T>(String path, {Map<String, dynamic>? query}) async {
    final res = await _dio.delete<T>(path, queryParameters: query);
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
