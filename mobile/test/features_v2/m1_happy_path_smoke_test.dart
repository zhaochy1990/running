/// M1 Happy-path smoke test (widget-level).
///
/// Rationale for widget-level instead of integration_test:
///   Integration tests require a real device/emulator and are not suitable
///   for CI without additional runner setup. Widget tests run headlessly and
///   cover the same router redirect + UI presence checks we care about for M1
///   acceptance.
///
/// What this test covers:
///   A1 (AuthStartScreen) renders with 登录 / 注册 buttons.
///   A2 (AuthLoginScreen) renders with email + password fields.
///   B1-B5 onboarding screens render their key copy.
///   D5 (TrainingScreen) renders the week day bar + today workout card when
///      weeklyPlanProvider is pre-seeded with a structured plan.
///
/// The router redirect chain (auth → onboarding → home) requires real async
/// state from authControllerProvider + currentUserProvider, which is backed
/// by live network calls. Fully wiring that chain in widget tests would
/// require mocking the SecureStorage + HTTP layers — acceptable for a
/// follow-up ticket (see T31-followup: full router integration smoke test).
/// Each screen is therefore tested in isolation via its own GoRouter fixture,
/// which is the same approach used by all existing test/features_v2/ tests.
library;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/core/router/routes.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/auth/start_screen.dart';
import 'package:stride/features_v2/auth/login_screen.dart';
import 'package:stride/features_v2/auth/register_screen.dart';
import 'package:stride/features_v2/training/training_screen.dart';
import 'package:stride/data/models/activity.dart';
import 'package:stride/shared/utils/shanghai_date.dart';
import 'package:stride/data/models/weekly_plan.dart';
import 'package:stride/features_v2/training/providers/training_providers.dart';
import 'package:stride/features_v2/onboarding/onboarding_screen.dart';
import 'package:stride/features_v2/onboarding/onboarding_sync.dart';

// ── Fixtures ──────────────────────────────────────────────────────────────

/// getStatus 直接抛错：验证「异常保守落点 = onboarding 资料步」。
class _FailingSyncService extends OnboardingSyncService {
  _FailingSyncService() : super(_ThrowApi());

  @override
  Future<OnboardingStatus> getStatus() async =>
      throw StateError('network down');
}

class _ThrowApi extends StrideApi {
  _ThrowApi() : super(Dio());
}

WeeklyPlanDetail _stubWeeklyPlan() => WeeklyPlanDetail(
  planId: 'plan-1',
  weekName: '2026-05-11_05-17',
  dateFrom: '2026-05-11',
  dateTo: '2026-05-17',
  status: 'active',
  content: WeeklyPlanContent(
    sessions: [
      PlannedSession(
        date: shanghaiToday(),
        sessionIndex: 0,
        kind: 'run',
        summary: '轻松跑 10km',
        spec: const RunWorkoutSpec(
          name: '晨间轻松跑',
          blocks: [
            WorkoutBlock(
              steps: [
                WorkoutStep(
                  stepKind: 'work',
                  target: WorkoutTarget(kind: 'hr_bpm', low: 130, high: 150),
                ),
              ],
            ),
          ],
        ),
        totalDistanceM: 10000,
        totalDurationS: 3600,
      ),
    ],
    nutrition: [],
  ),
);

// ── Generic screen pump helper ─────────────────────────────────────────────

Future<void> _pumpScreen(
  WidgetTester tester,
  Widget screen, {
  List<Override> overrides = const [],
  // Onboarding 页含不定长 spinner/轮询，需用定步长 pump 而非 pumpAndSettle。
  bool settle = true,
}) async {
  final router = GoRouter(
    routes: [
      GoRoute(path: '/', builder: (_, $) => screen),
      // Destination stubs so navigation calls don't throw.
      GoRoute(
        path: Routes.authLogin,
        builder: (_, $) => const Scaffold(body: Text('login-stub')),
      ),
      GoRoute(
        path: Routes.authRegister,
        builder: (_, $) => const Scaffold(body: Text('register-stub')),
      ),
      GoRoute(
        path: Routes.onboarding,
        builder: (_, $) => const Scaffold(body: Text('onboarding-stub')),
      ),
    ],
  );

  await tester.pumpWidget(
    ProviderScope(
      overrides: overrides,
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

void main() {
  // ── A1 AuthStartScreen ────────────────────────────────────────────────────

  group('A1 AuthStartScreen', () {
    testWidgets('shows STRIDE logo', (tester) async {
      await _pumpScreen(tester, const AuthStartScreen());
      expect(find.text('STRIDE'), findsOneWidget);
    });

    testWidgets('shows 登录 and 注册 buttons', (tester) async {
      await _pumpScreen(tester, const AuthStartScreen());
      expect(find.text('登录'), findsOneWidget);
      expect(find.text('注册'), findsOneWidget);
    });
  });

  // ── A2 AuthLoginScreen ────────────────────────────────────────────────────

  group('A2 AuthLoginScreen', () {
    testWidgets('shows email and password fields', (tester) async {
      await _pumpScreen(tester, const AuthLoginScreen());
      expect(find.byType(TextField), findsAtLeastNWidgets(2));
    });

    testWidgets('shows 登录 submit button', (tester) async {
      await _pumpScreen(tester, const AuthLoginScreen());
      // At least one "登录" text exists in the screen (button label or title).
      expect(find.text('登录'), findsAtLeastNWidgets(1));
    });
  });

  // ── A3 AuthRegisterScreen ─────────────────────────────────────────────────

  group('A3 AuthRegisterScreen', () {
    testWidgets('shows register form fields', (tester) async {
      await _pumpScreen(tester, const AuthRegisterScreen());
      expect(find.byType(TextField), findsAtLeastNWidgets(2));
    });
  });

  // ── Onboarding 单页三步（#461 重做后的替代屏）─────────────────────────

  group('OnboardingScreen', () {
    testWidgets('renders profile step (状态读取失败保守落资料步)', (tester) async {
      // getStatus() 抛错 → 保守落资料步（与线上一致的守卫语义）。
      await _pumpScreen(
        tester,
        const OnboardingScreen(),
        overrides: [
          onboardingSyncProvider.overrideWithValue(_FailingSyncService()),
        ],
        settle: false,
      );
      expect(find.text('先认识一下你'), findsOneWidget);
      expect(find.text('保存并继续'), findsOneWidget);
    });
  });

  // ── D5 TrainingScreen（/training 重建）─────────────────────────────────

  group('D5 TrainingScreen', () {
    testWidgets('renders week day bar and today workout card', (tester) async {
      final router = GoRouter(
        routes: [
          GoRoute(path: '/', builder: (_, $) => const TrainingScreen()),
          GoRoute(
            path: '/records/activity/:id',
            builder: (_, state) =>
                Scaffold(body: Text("detail-${state.pathParameters['id']}")),
          ),
        ],
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            weeklyPlanProvider.overrideWith(
              (_) => Future.value(_stubWeeklyPlan()),
            ),
            dayActivitiesProvider.overrideWith((_, _) => const <Activity>[]),
            currentUserIdProvider.overrideWithValue('u-happy'),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      // 周日期条 + 今日课表卡（结构化课表重建）。
      expect(find.text('本周训练'), findsOneWidget);
      expect(find.text('Mon'), findsOneWidget);
      expect(find.text('Sun'), findsOneWidget);
      expect(find.text('晨间轻松跑'), findsOneWidget);
      expect(find.text('和教练聊一聊'), findsOneWidget);
      // 无当日活动时不渲染活动 section。
      expect(find.textContaining('今日活动'), findsNothing);
    });
  });
} // end main
