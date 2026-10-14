import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:stride/core/api/api_exception.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/data/models/pipeline.dart';
import 'package:stride/data/models/profile.dart';
import 'package:stride/features_v2/onboarding/onboarding_sync.dart';

/// 记录调用的 Fake api：默认实现全部走 override map，未覆盖的抛错。
class _FakeApi extends StrideApi {
  _FakeApi() : super(Dio());

  MyProfile profile = const MyProfile(
    id: 'u-1',
    displayName: 'T',
    onboarding: OnboardingState(watchReady: true, profileReady: true),
    features: FeatureFlags(syncDataAtOnboarding: true),
  );

  TriggerSyncResult triggerResult = const TriggerSyncResult(runId: 'run-new');
  Object? triggerError;

  final Map<String, PipelineRun> runs = {};
  List<PipelineRun> userPipelines = [];

  final List<String> triggerKeys = [];

  /// 触发请求发出那一刻，磁盘上的幂等键快照（验证“先落盘再发请求”）。
  final List<String?> startKeyOnDiskAtTrigger = [];

  int completeCalls = 0;

  @override
  Future<MyProfile> getMyProfile() async => profile;

  @override
  Future<Map<String, dynamic>> completeOnboarding() async {
    completeCalls++;
    return const {'state': 'complete'};
  }

  @override
  Future<TriggerSyncResult> triggerSync(
    String user, {
    required bool full,
    String? idempotencyKey,
  }) async {
    triggerKeys.add(idempotencyKey ?? '');
    final prefs = await SharedPreferences.getInstance();
    startKeyOnDiskAtTrigger.add(
      prefs.getString('stride:onboarding-start-key:$user'),
    );
    if (triggerError != null) throw triggerError!;
    return triggerResult;
  }

  @override
  Future<PipelineRun> getPipelineRun(String runId) async {
    final run = runs[runId];
    if (run == null) {
      throw const ApiException(404, 'not found');
    }
    return run;
  }

  @override
  Future<List<PipelineRun>> listUserPipelines(String user) async =>
      userPipelines;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const uid = 'u-1';
  const runKey = 'stride:onboarding-run:$uid';
  const startKey = 'stride:onboarding-start-key:$uid';

  Future<(OnboardingSyncService, _FakeApi, SharedPreferences)> make() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final api = _FakeApi();
    return (OnboardingSyncService(api, prefs: prefs), api, prefs);
  }

  test('部署开关关（含字段缺失）→ disabled，不触发', () async {
    final (svc, api, prefs) = await make();
    api.profile = const MyProfile(
      id: uid,
      displayName: 'T',
      onboarding: OnboardingState(watchReady: true, profileReady: true),
      features: FeatureFlags(syncDataAtOnboarding: false),
    );
    expect((await svc.ensureSync(uid)).phase, SyncPhase.disabled);

    // 字段缺失按关。
    api.profile = const MyProfile(
      id: uid,
      displayName: 'T',
      onboarding: OnboardingState(watchReady: true, profileReady: true),
    );
    expect((await svc.ensureSync(uid)).phase, SyncPhase.disabled);
    expect(api.triggerKeys, isEmpty);
    expect(prefs.getString(runKey), isNull);
  });

  test('无表 → noWatch', () async {
    final (svc, api, _) = await make();
    api.profile = const MyProfile(
      id: uid,
      displayName: 'T',
      onboarding: OnboardingState(watchReady: false, profileReady: true),
      features: FeatureFlags(syncDataAtOnboarding: true),
    );
    expect((await svc.ensureSync(uid)).phase, SyncPhase.noWatch);
  });

  test('触发：幂等键先落盘再发请求，成功后 savePointer + 清 startKey', () async {
    final (svc, api, prefs) = await make();
    api.runs['run-new'] = const PipelineRun(
      runId: 'run-new',
      pipelineName: 'onboarding',
      status: 'running',
      currentStep: 0,
    );
    final res = await svc.ensureSync(uid);

    expect(res.phase, SyncPhase.running);
    expect(res.runId, 'run-new');
    // key 发出去的那一刻就已经在磁盘上（先落盘再发请求）
    expect(api.triggerKeys.single, isNotEmpty);
    expect(api.startKeyOnDiskAtTrigger.single, api.triggerKeys.single);
    expect(prefs.getString(runKey), 'run-new');
    // run 已建出来，key 的使命结束：清掉，失败重试才起得了一个新 run
    expect(prefs.getString(startKey), isNull);

    // 再 ensureSync：指针 valid 复用，不再触发
    final res2 = await svc.ensureSync(uid);
    expect(res2.phase, SyncPhase.running);
    expect(res2.runId, 'run-new');
    expect(api.triggerKeys.length, 1);
  });

  test('幂等 deduplicated 命中：复用已有 run', () async {
    final (svc, api, prefs) = await make();
    api.triggerResult = const TriggerSyncResult(
      runId: 'run-existing',
      deduplicated: true,
    );
    // deduplicated 的 run 也可查（valid 指针路径之外首次触发路径）
    final res = await svc.ensureSync(uid);
    expect(res.runId, 'run-existing');
    expect(prefs.getString(runKey), 'run-existing');
    expect(prefs.getString(startKey), isNull);
  });

  test('指针三分 — 4xx invalid 清除后重触发', () async {
    final (svc, api, prefs) = await make();
    await prefs.setString(runKey, 'run-stale');
    api.runs['run-new'] = const PipelineRun(
      runId: 'run-new',
      pipelineName: 'onboarding',
      status: 'running',
      currentStep: 0,
    );
    final res = await svc.ensureSync(uid);
    expect(res.runId, 'run-new');
    expect(prefs.getString(runKey), 'run-new');
  });

  test('指针三分 — 5xx transient 保留指针按原 runId 续跑', () async {
    final (svc, api, prefs) = await make();
    await prefs.setString(runKey, 'run-live');
    api.runs['run-live'] = const PipelineRun(
      runId: 'run-live',
      pipelineName: 'onboarding',
      status: 'running',
      currentStep: 1,
    );
    // getPipelineRun 抛 500（服务端抖了）
    int calls = 0;
    final probe = OnboardingSyncService(
      _FlakyApi(
        api,
        onGetPipelineRun: (_) {
          calls++;
          throw const ApiException(500, 'boom');
        },
      ),
      prefs: prefs,
    );
    final res = await probe.ensureSync(uid);
    expect(res.phase, SyncPhase.running);
    expect(res.runId, 'run-live');
    expect(prefs.getString(runKey), 'run-live');
    expect(calls, 1);
  });

  test('指针三分 — 非 onboarding run 视为 invalid', () async {
    final (svc, api, prefs) = await make();
    await prefs.setString(runKey, 'run-other');
    api.runs['run-other'] = const PipelineRun(
      runId: 'run-other',
      pipelineName: 'watch_sync',
      status: 'running',
      currentStep: 0,
    );
    api.runs['run-new'] = const PipelineRun(
      runId: 'run-new',
      pipelineName: 'onboarding',
      status: 'running',
      currentStep: 0,
    );
    final res = await svc.ensureSync(uid);
    expect(res.runId, 'run-new');
  });

  test('本地指针丢失 → 认领别端非 failed 的 onboarding run（done 也认领展示）', () async {
    final (svc, api, prefs) = await make();
    api.userPipelines = [
      const PipelineRun(
        runId: 'run-other-pipeline',
        pipelineName: 'watch_sync',
        status: 'done',
        currentStep: 0,
      ),
      const PipelineRun(
        runId: 'run-from-mp',
        pipelineName: 'onboarding',
        status: 'done',
        currentStep: 5,
      ),
    ];
    final res = await svc.ensureSync(uid);
    expect(res.phase, SyncPhase.done);
    expect(res.runId, 'run-from-mp');
    expect(prefs.getString(runKey), 'run-from-mp');
    expect(api.triggerKeys, isEmpty); // 不触发新 run
  });

  test('failed run 不认领：清指针重试起**新** run', () async {
    final (svc, api, prefs) = await make();
    await prefs.setString(runKey, 'run-failed');
    api.runs['run-failed'] = const PipelineRun(
      runId: 'run-failed',
      pipelineName: 'onboarding',
      status: 'failed',
      currentStep: 0,
      errorMessage: 'watch login failed',
    );
    final res = await svc.retrySync(uid);
    expect(res.phase, SyncPhase.running);
    expect(res.runId, 'run-new');
    expect(prefs.getString(runKey), 'run-new');
  });

  test('markComplete 空体幂等；getStatus 读取 onboarding/features 字段', () async {
    final (svc, api, _) = await make();
    api.profile = const MyProfile(
      id: uid,
      displayName: 'T',
      onboarding: OnboardingState(
        watchReady: true,
        profileReady: true,
        completedAt: '2026-01-01T00:00:00Z',
      ),
      features: FeatureFlags(syncDataAtOnboarding: true),
    );
    final status = await svc.getStatus();
    expect(status.watchReady, isTrue);
    expect(status.profileReady, isTrue);
    expect(status.completed, isTrue);
    expect(status.syncEnabled, isTrue);
    await svc.markComplete();
  });
}

/// 包装 FakeApi，只覆写 getPipelineRun。
class _FlakyApi extends StrideApi {
  _FlakyApi(this._inner, {this.onGetPipelineRun}) : super(Dio());

  final StrideApi _inner;
  final void Function(String runId)? onGetPipelineRun;

  @override
  Future<MyProfile> getMyProfile() => _inner.getMyProfile();

  @override
  Future<TriggerSyncResult> triggerSync(
    String user, {
    required bool full,
    String? idempotencyKey,
  }) => _inner.triggerSync(user, full: full, idempotencyKey: idempotencyKey);

  @override
  Future<PipelineRun> getPipelineRun(String runId) async {
    onGetPipelineRun?.call(runId);
    throw const ApiException(500, 'boom');
  }

  @override
  Future<List<PipelineRun>> listUserPipelines(String user) =>
      _inner.listUserPipelines(user);
}
