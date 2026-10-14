/// Onboarding 同步服务 —— 镜像小程序 services/onboarding.ts 的状态机：
///
///   1. 完成（complete）：只要求基础档案（ADR 0013），资料保存成功即可标记完成。
///   2. 数据同步（sync）：绑表之后触发的 full sync，**不是**完成的前置。
///
/// ensureSync 五段链：部署开关 → 有表 → 本地指针三分（valid/transient/invalid）
/// → 认领别端 run → 触发（幂等键**先落盘再发请求**）。
/// 指针/幂等键 key 名与 Web/小程序同名（shared_preferences 实现）。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/api/api_exception.dart';
import '../../data/api/stride_api.dart';
import '../../data/models/pipeline.dart';
import '../../data/models/profile.dart';

/// onboarding pipeline 的名字（Go catalog.PipelineOnboarding）。
const onboardingPipelineName = 'onboarding';

// 同步 run 的本地指针。键名带 userId 是因为可以换账号；前缀沿用 Web/小程序，
// 两端对照排查时能对上。
const _runKeyPrefix = 'stride:onboarding-run:';
const _startKeyPrefix = 'stride:onboarding-start-key:';

/// onboarding 状态（来自 GET /api/users/me/profile）。
class OnboardingStatus {
  const OnboardingStatus({
    required this.watchReady,
    required this.profileReady,
    required this.completed,
    required this.syncEnabled,
  });

  final bool watchReady;
  final bool profileReady;
  final bool completed;

  /// 部署开关：config.yml 的 sync-data-at-onboarding，只关同步、不影响完成。
  final bool syncEnabled;
}

enum SyncPhase { disabled, noWatch, running, done, failed }

class SyncOutcome {
  const SyncOutcome({required this.phase, this.runId, this.message});

  final SyncPhase phase;
  final String? runId;
  final String? message;
}

class OnboardingSyncService {
  OnboardingSyncService(this._api, {SharedPreferences? prefs}) : _prefs = prefs;

  final StrideApi _api;
  SharedPreferences? _prefs;

  Future<SharedPreferences> get _storage async {
    _prefs ??= await SharedPreferences.getInstance();
    return _prefs!;
  }

  /// 读 onboarding 状态。复用 GET /api/users/me/profile（后端本来就在返回）。
  Future<OnboardingStatus> getStatus() async {
    final MyProfile p = await _api.getMyProfile();
    final onb = p.onboarding;
    return OnboardingStatus(
      watchReady: onb.watchReady,
      profileReady: onb.profileReady,
      completed: onb.completedAt != null,
      // 字段缺失按"关"处理：宁可不动 24 分钟的 pipeline，也不要在开关未知时乱触发
      syncEnabled: p.syncDataAtOnboarding,
    );
  }

  /// 标记 onboarding 完成。资料已保存时调用；服务端幂等（已完成返回
  /// already-complete）。不传 run_id：完成不再需要 pipeline（ADR 0013）。
  Future<void> markComplete() => _api.completeOnboarding();

  /// 幂等入口：确保该用户有一个正在跑的同步 run，返回当前该走的状态。
  Future<SyncOutcome> ensureSync(String userId) async {
    final status = await getStatus();
    if (!status.syncEnabled) {
      return const SyncOutcome(phase: SyncPhase.disabled);
    }
    if (!status.watchReady) {
      return const SyncOutcome(phase: SyncPhase.noWatch);
    }

    // 1) 本地指针三分：valid 复用 / transient（5xx、网络异常）保留指针继续轮询 /
    //    invalid（4xx 且非 onboarding）清除。
    final stored = await readPointer(userId);
    if (stored != null) {
      final lookup = await _lookupRun(stored);
      if (lookup.verdict == _Verdict.valid && lookup.run != null) {
        return _toOutcome(lookup.run!);
      }
      if (lookup.verdict == _Verdict.transient) {
        // 查不动（服务端抖了）：保留指针，让页面继续按这个 runId 轮询
        return SyncOutcome(phase: SyncPhase.running, runId: stored);
      }
      await clearPointer(userId);
    }

    // 2) 认领别端已起的 run（换设备 / 小程序、Web 先起过）。
    //    只认非 failed 的：failed 需要用户主动重试；done 的正好认领展示结果。
    try {
      final existing = await _api.listUserPipelines(userId);
      final run = existing.firstWhere(
        (r) => r.pipelineName == onboardingPipelineName && !r.isFailed,
        orElse: () => const PipelineRun(
          runId: '',
          pipelineName: '',
          status: '',
          currentStep: 0,
        ),
      );
      if (run.runId.isNotEmpty) {
        await savePointer(userId, run.runId);
        return _toOutcome(run);
      }
    } catch (_) {
      // 列不出来不阻断：幂等键仍然保证不会重复建 run
    }

    // 3) 触发。key 必须**先落盘再发请求**：请求超时/响应丢失时下次进来复用同一把
    //    key，服务端 uq_runs_user_idem 会返回已创建的那个 run，而不是再建一个。
    final key = await _startKeyFor(userId);
    final res = await _api.triggerSync(userId, full: true, idempotencyKey: key);
    await savePointer(userId, res.runId);
    // run 已经建出来了，key 的使命到此结束（它只防"重复创建"），续跑靠 runId 指针。
    // 清掉它，用户失败后重试才算一次新尝试、才会起新 run。
    await clearStartKey(userId);
    return SyncOutcome(phase: SyncPhase.running, runId: res.runId);
  }

  /// 失败后重试：清指针与旧 key，确保起一个**新** run
  /// （否则幂等键会把那个失败的 run 带回来）。
  Future<SyncOutcome> retrySync(String userId) async {
    await clearPointer(userId);
    await clearStartKey(userId);
    return ensureSync(userId);
  }

  // ── 本地指针 / 幂等键 ─────────────────────────────────────────────────

  Future<String?> readPointer(String userId) async {
    final v = (await _storage).getString(_runKeyPrefix + userId);
    return (v == null || v.isEmpty) ? null : v;
  }

  Future<void> savePointer(String userId, String runId) async {
    await (await _storage).setString(_runKeyPrefix + userId, runId);
  }

  Future<void> clearPointer(String userId) async {
    await (await _storage).remove(_runKeyPrefix + userId);
  }

  /// 幂等键：读不到才生成，且先落盘再用（理由见 ensureSync 第 3 段）。
  Future<String> _startKeyFor(String userId) async {
    final storage = await _storage;
    final existing = storage.getString(_startKeyPrefix + userId);
    if (existing != null && existing.isNotEmpty) return existing;
    final key =
        'app-onboarding-$userId-${DateTime.now().millisecondsSinceEpoch}-'
        '${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}';
    await storage.setString(_startKeyPrefix + userId, key);
    return key;
  }

  Future<void> clearStartKey(String userId) async {
    await (await _storage).remove(_startKeyPrefix + userId);
  }

  // ── run 查询与分类 ────────────────────────────────────────────────────

  Future<_Lookup> _lookupRun(String runId) async {
    try {
      final run = await _api.getPipelineRun(runId);
      if (run.pipelineName != onboardingPipelineName) {
        return const _Lookup(_Verdict.invalid);
      }
      return _Lookup(_Verdict.valid, run);
    } catch (err) {
      // 4xx = 服务端明确不认这个 run（不存在 / 不属于我）→ 指针作废重开；
      // 5xx 与网络异常是暂时性的 → 保留指针，免得白扔一个已跑了很久的 full sync。
      if (err is ApiException &&
          err.statusCode >= 400 &&
          err.statusCode < 500) {
        return const _Lookup(_Verdict.invalid);
      }
      return const _Lookup(_Verdict.transient);
    }
  }

  SyncOutcome _toOutcome(PipelineRun run) {
    if (run.isFailed) {
      return SyncOutcome(
        phase: SyncPhase.failed,
        runId: run.runId,
        message: run.errorMessage,
      );
    }
    if (run.isDone) return SyncOutcome(phase: SyncPhase.done, runId: run.runId);
    return SyncOutcome(phase: SyncPhase.running, runId: run.runId);
  }
}

enum _Verdict { valid, invalid, transient }

class _Lookup {
  const _Lookup(this.verdict, [this.run]);
  final _Verdict verdict;
  final PipelineRun? run;
}

final onboardingSyncProvider = Provider<OnboardingSyncService>((ref) {
  final api = ref.watch(strideApiProvider);
  return OnboardingSyncService(api);
});
