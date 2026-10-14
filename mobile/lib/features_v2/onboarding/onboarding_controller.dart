/// Onboarding 单页三步状态机（镜像小程序 pages/onboarding/onboarding.ts）。
///
/// 五视图：loading / profile / watch / sync / ready。落点每次进入页面
/// （autoDispose 重建）与 AppLifecycleState.resumed 时重算（refresh()），
/// 所以续跑是天然的：App 必然会在 24 分钟的同步中途被杀，每次回来都按
/// profile_ready / watch_ready 重新落到该去的那一步。
/// 资料齐但完成标记没写上（上次 complete 失败）会补一次，自愈。
library;

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_exception.dart';
import '../../core/auth/current_user.dart';
import '../../data/api/stride_api.dart';
import '../../data/models/pipeline.dart';
import 'onboarding_steps.dart';
import 'onboarding_sync.dart';

enum OnboardingStep { loading, profile, watch, sync, ready }

class OnboardingUi {
  const OnboardingUi({
    this.step = OnboardingStep.loading,
    this.displayName = '',
    this.dob,
    this.sex,
    this.heightCm = '',
    this.weightKg = '',
    this.runningAgeRange,
    this.saving = false,
    this.formError,
    this.provider,
    this.watchEmail = '',
    this.watchPassword = '',
    this.watchRegion = 'cn',
    this.connecting = false,
    this.watchError,
    this.syncText = '正在准备同步…',
    this.percent = 0,
    this.syncError,
    this.syncPending = false,
  });

  final OnboardingStep step;

  // ── 资料步（六字段，OPTIONS 展示与 VALUES 提交分离见 screen）──────────
  final String displayName;
  final String? dob;
  final String? sex;
  final String heightCm;
  final String weightKg;
  final String? runningAgeRange;
  final bool saving;
  final String? formError;

  // ── 绑表步 ────────────────────────────────────────────────────────────
  final String? provider;
  final String watchEmail;
  final String watchPassword;
  final String watchRegion;
  final bool connecting;
  final String? watchError;

  // ── 同步步 ────────────────────────────────────────────────────────────
  final String syncText;
  final int percent;
  final String? syncError;

  /// 轮询到达 60min 上限但 run 还在跑（不是失败）：让用户先走，下次进来续跑。
  final bool syncPending;

  OnboardingUi copyWith({
    OnboardingStep? step,
    String? displayName,
    String? dob,
    String? sex,
    String? heightCm,
    String? weightKg,
    String? runningAgeRange,
    bool? saving,
    String? formError,
    String? provider,
    String? watchEmail,
    String? watchPassword,
    String? watchRegion,
    bool? connecting,
    String? watchError,
    String? syncText,
    int? percent,
    String? syncError,
    bool? syncPending,
    bool clearDob = false,
    bool clearSex = false,
    bool clearAgeRange = false,
    bool clearProvider = false,
    bool clearFormError = false,
    bool clearWatchError = false,
    bool clearSyncError = false,
  }) {
    return OnboardingUi(
      step: step ?? this.step,
      displayName: displayName ?? this.displayName,
      dob: clearDob ? null : (dob ?? this.dob),
      sex: clearSex ? null : (sex ?? this.sex),
      heightCm: heightCm ?? this.heightCm,
      weightKg: weightKg ?? this.weightKg,
      runningAgeRange: clearAgeRange
          ? null
          : (runningAgeRange ?? this.runningAgeRange),
      saving: saving ?? this.saving,
      formError: clearFormError ? null : (formError ?? this.formError),
      provider: clearProvider ? null : (provider ?? this.provider),
      watchEmail: watchEmail ?? this.watchEmail,
      watchPassword: watchPassword ?? this.watchPassword,
      watchRegion: watchRegion ?? this.watchRegion,
      connecting: connecting ?? this.connecting,
      watchError: clearWatchError ? null : (watchError ?? this.watchError),
      syncText: syncText ?? this.syncText,
      percent: percent ?? this.percent,
      syncError: clearSyncError ? null : (syncError ?? this.syncError),
      syncPending: syncPending ?? this.syncPending,
    );
  }
}

class OnboardingController extends StateNotifier<OnboardingUi>
    with WidgetsBindingObserver {
  OnboardingController(this._ref) : super(const OnboardingUi()) {
    WidgetsBinding.instance.addObserver(this);
    unawaited(refresh());
  }

  final Ref _ref;
  Timer? _poll;
  DateTime? _deadline;
  bool _disposed = false;

  static const _pollInterval = Duration(seconds: 2);
  static const _pollTimeout = Duration(minutes: 60);

  OnboardingSyncService get _svc => _ref.read(onboardingSyncProvider);

  /// 等 profile（含 id）就绪再取 userId：刷新常在 currentUserProvider 尚在加载时
  /// 被触发，直接读 valueOrNull 会拿到 null 而误落到 ready。
  Future<String?> _resolveUserId() async {
    try {
      return (await _ref.read(currentUserProvider.future))?.id;
    } catch (_) {
      return null;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_disposed) return;
    // 前台恢复重算落点：杀进程回来靠路由重建，这里覆盖不杀进程的挂后台。
    if (state == AppLifecycleState.resumed) unawaited(refresh());
  }

  // ── 资料步输入 ────────────────────────────────────────────────────────

  void setDisplayName(String v) =>
      state = state.copyWith(displayName: v, clearFormError: true);
  void setDob(String v) => state = state.copyWith(dob: v, clearFormError: true);
  void setSex(String? v) =>
      state = state.copyWith(sex: v, clearFormError: true);
  void setHeightCm(String v) =>
      state = state.copyWith(heightCm: v, clearFormError: true);
  void setWeightKg(String v) =>
      state = state.copyWith(weightKg: v, clearFormError: true);
  void setRunningAgeRange(String? v) =>
      state = state.copyWith(runningAgeRange: v, clearFormError: true);

  // ── 绑表步输入 ────────────────────────────────────────────────────────

  void selectProvider(String p) =>
      state = state.copyWith(provider: p, clearWatchError: true);
  void setWatchEmail(String v) =>
      state = state.copyWith(watchEmail: v, clearWatchError: true);
  void setWatchPassword(String v) =>
      state = state.copyWith(watchPassword: v, clearWatchError: true);
  void setWatchRegion(String v) =>
      state = state.copyWith(watchRegion: v, clearWatchError: true);

  // ── 落点重算 ──────────────────────────────────────────────────────────

  /// 唯一的落点决策：每次进页面都按服务端状态重算该停在哪一步。
  Future<void> refresh() async {
    _cancelPoll();
    state = state.copyWith(
      step: OnboardingStep.loading,
      clearFormError: true,
      clearWatchError: true,
      clearSyncError: true,
      syncPending: false,
    );

    final OnboardingStatus status;
    try {
      status = await _svc.getStatus();
    } catch (_) {
      state = state.copyWith(
        step: OnboardingStep.profile,
        formError: '加载失败，请检查网络后重试',
      );
      return;
    }

    if (!status.profileReady) {
      state = state.copyWith(step: OnboardingStep.profile);
      return;
    }
    // 资料齐了但完成标记没写上（上次 complete 失败 / 别端没走完）→ 补一次，自愈。
    if (!status.completed) {
      try {
        await _svc.markComplete();
      } catch (_) {
        // 失败不打断流程（进页面时会重试）
      }
    }
    if (!status.watchReady) {
      state = state.copyWith(step: OnboardingStep.watch);
      return;
    }

    final userId = await _resolveUserId();
    if (userId == null || userId.isEmpty) {
      state = state.copyWith(step: OnboardingStep.ready);
      return;
    }
    try {
      await applySyncOutcome(await _svc.ensureSync(userId));
    } catch (_) {
      state = state.copyWith(
        step: OnboardingStep.sync,
        syncError: '同步启动失败，请重试',
      );
    }
  }

  // ── 资料保存（完成只发生在这一步，ADR 0013）────────────────────────────

  Future<void> saveProfile() async {
    if (state.saving) return;
    // 局部拷贝让类型提升生效：下方 return 后六项全部非空。
    final name = state.displayName.trim();
    final dob = state.dob;
    final sex = state.sex;
    final height = double.tryParse(state.heightCm);
    final weight = double.tryParse(state.weightKg);
    final ageRange = state.runningAgeRange;
    if (name.isEmpty ||
        dob == null ||
        sex == null ||
        ageRange == null ||
        height == null ||
        height <= 0 ||
        weight == null ||
        weight <= 0) {
      final missing = <String>[
        if (name.isEmpty) '昵称',
        if (dob == null) '生日',
        if (sex == null) '性别',
        if (height == null || height <= 0) '身高',
        if (weight == null || weight <= 0) '体重',
        if (ageRange == null) '跑步年限',
      ];
      state = state.copyWith(formError: '还差：${missing.join('、')}');
      return;
    }

    state = state.copyWith(saving: true, clearFormError: true);
    try {
      await _ref
          .read(strideApiProvider)
          .postProfile(
            displayName: name,
            dob: dob,
            sex: sex,
            heightCm: height,
            weightKg: weight,
            runningAgeRange: ageRange,
          );
    } on ApiException catch (e) {
      state = state.copyWith(
        saving: false,
        formError: _apiError(e, '保存失败，请重试'),
      );
      return;
    } catch (_) {
      state = state.copyWith(saving: false, formError: '网络异常，请检查网络后重试');
      return;
    }
    try {
      await _svc.markComplete();
    } catch (_) {
      // 自愈路径：下次进页面 refresh() 会补
    }
    // 路由守卫读 currentUserProvider 的 completed_at，保存后要让它重取。
    _ref.invalidate(currentUserProvider);
    state = state.copyWith(saving: false);
    await refresh();
  }

  // ── 绑表（可跳过）────────────────────────────────────────────────────

  Future<void> bindWatch() async {
    if (state.connecting) return;
    final provider = state.provider;
    if (provider == null) {
      state = state.copyWith(watchError: '请先选择手表品牌');
      return;
    }
    if (state.watchEmail.trim().isEmpty || state.watchPassword.isEmpty) {
      state = state.copyWith(watchError: '请填写账号与密码');
      return;
    }

    state = state.copyWith(connecting: true, clearWatchError: true);
    try {
      await _ref
          .read(strideApiProvider)
          .watchLogin(
            provider: provider,
            email: state.watchEmail.trim(),
            password: state.watchPassword,
            region: state.watchRegion,
          );
    } on ApiException catch (e) {
      state = state.copyWith(connecting: false, watchError: _watchError(e));
      return;
    } catch (_) {
      state = state.copyWith(connecting: false, watchError: '网络异常，请检查网络后重试');
      return;
    }
    _ref.invalidate(currentUserProvider);
    state = state.copyWith(connecting: false, watchPassword: '');

    final userId = await _resolveUserId();
    if (userId == null || userId.isEmpty) {
      state = state.copyWith(step: OnboardingStep.ready);
      return;
    }
    try {
      await applySyncOutcome(await _svc.ensureSync(userId));
    } catch (_) {
      state = state.copyWith(
        step: OnboardingStep.sync,
        syncError: '同步启动失败，请重试',
      );
    }
  }

  // ── 同步步 ────────────────────────────────────────────────────────────

  Future<void> applySyncOutcome(SyncOutcome res) async {
    switch (res.phase) {
      case SyncPhase.disabled:
      case SyncPhase.done:
        state = state.copyWith(step: OnboardingStep.ready);
        return;
      case SyncPhase.noWatch:
        state = state.copyWith(step: OnboardingStep.watch);
        return;
      case SyncPhase.running:
        if (res.runId != null) _startPolling(res.runId!);
        return;
      case SyncPhase.failed:
        state = state.copyWith(
          step: OnboardingStep.sync,
          syncError: res.message ?? '同步失败',
        );
        return;
    }
  }

  void _startPolling(String runId) {
    _cancelPoll();
    state = state.copyWith(
      step: OnboardingStep.sync,
      percent: 0,
      syncText: '正在准备同步…',
      clearSyncError: true,
      syncPending: false,
    );
    _deadline = DateTime.now().add(_pollTimeout);
    _schedulePoll(runId, immediate: true);
  }

  void _schedulePoll(String runId, {bool immediate = false}) {
    _poll?.cancel();
    if (_disposed) return;
    _poll = Timer(
      immediate ? Duration.zero : _pollInterval,
      () => unawaited(_pollTick(runId)),
    );
  }

  Future<void> _pollTick(String runId) async {
    if (_disposed) return;
    if (_deadline != null && DateTime.now().isAfter(_deadline!)) {
      // 60 分钟轮询上限不是失败：pipeline 还在跑（生产最长见过 51 分钟）。
      // 让用户先走，下次进页面靠本地指针接着续跑。
      state = state.copyWith(syncPending: true, syncText: '还在同步中');
      return;
    }
    final PipelineRun run;
    try {
      run = await _ref.read(strideApiProvider).getPipelineRun(runId);
    } on ApiException catch (e) {
      state = state.copyWith(
        step: OnboardingStep.sync,
        syncError: _apiError(e, '同步失败'),
      );
      return;
    } catch (_) {
      // Transient network glitch — keep polling.
      _schedulePoll(runId);
      return;
    }

    if (run.isDone) {
      state = state.copyWith(step: OnboardingStep.ready, percent: 100);
      _ref.invalidate(currentUserProvider);
      return;
    }
    if (run.isFailed) {
      state = state.copyWith(
        step: OnboardingStep.sync,
        syncError: run.errorMessage ?? '同步失败',
      );
      return;
    }
    final p = describeRun(run);
    state = state.copyWith(
      syncText: '第 ${p.stepIndex}/${p.stepTotal} 步 · ${p.label}',
      percent: p.percent,
    );
    _schedulePoll(runId);
  }

  Future<void> retrySync() async {
    final userId = await _resolveUserId();
    if (userId == null) return;
    state = state.copyWith(clearSyncError: true, syncPending: false);
    try {
      await applySyncOutcome(await _svc.retrySync(userId));
    } catch (_) {
      state = state.copyWith(syncError: '重试失败，请稍后再试');
    }
  }

  void _cancelPoll() {
    _poll?.cancel();
    _poll = null;
    _deadline = null;
  }

  String _apiError(ApiException e, String fallback) {
    if (e.isServerError) return '服务端异常，请稍后重试';
    final raw = e.detail is Map && (e.detail as Map)['detail'] != null
        ? (e.detail as Map)['detail'].toString()
        : e.message;
    return raw.isEmpty ? fallback : raw;
  }

  String _watchError(ApiException e) {
    final raw = _apiError(e, '绑定失败，请重试');
    if (e.statusCode == 400 || e.statusCode == 401) {
      final lower = raw.toLowerCase();
      if (lower.contains('region') ||
          raw.contains('区域') ||
          raw.contains('地区')) {
        return '请切换区域后重试';
      }
      return '邮箱或密码错误，请核对 $providerLabel 账号';
    }
    return raw;
  }

  String get providerLabel => state.provider == 'garmin' ? 'Garmin' : 'COROS';
}

final onboardingControllerProvider =
    StateNotifierProvider.autoDispose<OnboardingController, OnboardingUi>(
      (ref) => OnboardingController(ref),
    );
