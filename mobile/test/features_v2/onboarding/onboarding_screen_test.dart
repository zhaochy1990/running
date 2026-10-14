import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/core/router/routes.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/data/models/pipeline.dart';
import 'package:stride/data/models/profile.dart';
import 'package:stride/features_v2/onboarding/onboarding_screen.dart';
import 'package:stride/features_v2/onboarding/onboarding_sync.dart';

class _NoopApi extends StrideApi {
  _NoopApi() : super(Dio());

  PipelineRun run = const PipelineRun(
    runId: 'run-x',
    pipelineName: 'onboarding',
    status: 'running',
    currentStep: 0,
    steps: [
      PipelineStep(name: 'sync', status: 'running'),
      PipelineStep(name: 'race_detection', status: 'queued'),
      PipelineStep(name: 'calibration', status: 'queued'),
      PipelineStep(name: 'compute', status: 'queued'),
      PipelineStep(name: 'route_thumbnails', status: 'queued'),
      PipelineStep(name: 'ability', status: 'queued'),
    ],
  );

  @override
  Future<PipelineRun> getPipelineRun(String runId) async => run;
}

/// 按 test 场景返回预设 status / outcome 的假 service。
class _FakeSyncService extends OnboardingSyncService {
  _FakeSyncService({required this.status, required this.outcome})
    : super(_NoopApi());

  final OnboardingStatus status;
  final SyncOutcome outcome;

  @override
  Future<OnboardingStatus> getStatus() async => status;

  @override
  Future<SyncOutcome> ensureSync(String userId) async => outcome;

  @override
  Future<SyncOutcome> retrySync(String userId) async => outcome;

  @override
  Future<void> markComplete() async {}
}

MyProfile _profile({bool watchReady = false}) => MyProfile(
  id: 'u-1',
  displayName: 'T',
  onboarding: OnboardingState(
    watchReady: watchReady,
    profileReady: true,
    completedAt: '2026-01-01T00:00:00Z',
  ),
  features: const FeatureFlags(syncDataAtOnboarding: true),
);

Future<void> _pump(
  WidgetTester tester, {
  required OnboardingSyncService sync,
  MyProfile? profile,
}) async {
  SharedPreferences.setMockInitialValues({});
  final router = GoRouter(
    initialLocation: Routes.onboarding,
    routes: [
      GoRoute(
        path: Routes.onboarding,
        builder: (_, $) => const OnboardingScreen(),
      ),
      GoRoute(
        path: Routes.training,
        builder: (_, $) => const Scaffold(body: Text('home-stub')),
      ),
    ],
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        onboardingSyncProvider.overrideWithValue(sync),
        currentUserProvider.overrideWith((_) async => profile),
        // 轮询走 _NoopApi（假 run）。
        strideApiProvider.overrideWithValue(_NoopApi()),
      ],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
}

void main() {
  testWidgets('资料步：六字段中文表单 + 空表提交显示缺项', (tester) async {
    await _pump(
      tester,
      sync: _FakeSyncService(
        status: const OnboardingStatus(
          watchReady: false,
          profileReady: false,
          completed: false,
          syncEnabled: true,
        ),
        outcome: const SyncOutcome(phase: SyncPhase.noWatch),
      ),
      profile: _profile(),
    );
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('先认识一下你'), findsOneWidget);
    expect(find.text('昵称'), findsOneWidget);
    expect(find.text('性别'), findsOneWidget);
    expect(find.text('生日'), findsOneWidget);
    expect(find.text('身高 (cm)'), findsOneWidget);
    expect(find.text('体重 (kg)'), findsOneWidget);
    expect(find.text('跑步年限'), findsOneWidget);

    await tester.tap(find.text('保存并继续'));
    await tester.pump();
    expect(find.textContaining('还差'), findsOneWidget);
  });

  testWidgets('无表放行（原 M1 blocked 冒烟改写）：绑表步可跳过直达首页，无死路', (tester) async {
    await _pump(
      tester,
      sync: _FakeSyncService(
        status: const OnboardingStatus(
          watchReady: false,
          profileReady: true,
          completed: true,
          syncEnabled: true,
        ),
        outcome: const SyncOutcome(phase: SyncPhase.noWatch),
      ),
      profile: _profile(),
    );
    await tester.pump(const Duration(milliseconds: 50));

    // 绑表步渲染 + 「稍后再说，先逛逛」放行入口。
    expect(find.text('连接你的运动手表'), findsOneWidget);
    expect(find.text('稍后再说，先逛逛'), findsOneWidget);
    await tester.tap(find.text('稍后再说，先逛逛'));
    await tester.pumpAndSettle();
    expect(find.text('home-stub'), findsOneWidget);
  });

  testWidgets('同步步：轮询六步 run，显示第 x/6 步中文标签', (tester) async {
    await _pump(
      tester,
      sync: _FakeSyncService(
        status: const OnboardingStatus(
          watchReady: true,
          profileReady: true,
          completed: true,
          syncEnabled: true,
        ),
        outcome: const SyncOutcome(phase: SyncPhase.running, runId: 'run-x'),
      ),
      profile: _profile(watchReady: true),
    );
    await tester.pump(const Duration(milliseconds: 50));
    // 第一拍轮询（Duration.zero timer）已回填进度文案。
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.textContaining('第 1/6 步'), findsOneWidget);
    expect(find.textContaining('同步训练数据'), findsOneWidget);
    expect(find.text('先进入首页'), findsOneWidget);
  });

  testWidgets('done 落点 → ready 视图，进入首页回主 tab', (tester) async {
    await _pump(
      tester,
      sync: _FakeSyncService(
        status: const OnboardingStatus(
          watchReady: true,
          profileReady: true,
          completed: true,
          syncEnabled: true,
        ),
        outcome: const SyncOutcome(phase: SyncPhase.done, runId: 'run-x'),
      ),
      profile: _profile(watchReady: true),
    );
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('准备就绪'), findsOneWidget);

    await tester.tap(find.text('进入首页'));
    await tester.pumpAndSettle();
    expect(find.text('home-stub'), findsOneWidget);
  });
}
