import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/features_v2/home/home_screen.dart';
import 'package:stride/features_v2/home/models/home_data.dart';
import 'package:stride/features_v2/home/providers/home_provider.dart';

// ── Fixtures ──────────────────────────────────────────────────────────────

const _ring = StatusRing(
  fatigue: 42,
  fatigueBand: 'normal',
  tsb: -8.5,
  tsbBand: 'productive',
  loadRatio: 0.95,
  loadState: 'Optimal',
);

const _weeklyStats = WeeklyStats(
  weekStart: '2026-05-11',
  totalDistanceKm: 42.0,
  totalDurationSec: 14400,
  sessionCount: 5,
);

const _lifetimeStats = LifetimeStats(
  totalDistanceKm: 1842.5,
  totalActivities: 312,
);

final _activity = HomeActivity(
  labelId: 'ACT_001',
  date: '2026-05-11',
  name: '晨跑 10K',
  sportType: 'running',
  distanceKm: 10.2,
  durationSec: 3245,
  avgPaceSecPerKm: 318,
  avgHr: 152,
  commentaryExcerpt: '节奏稳定，状态不错。',
);

HomeData _makeHomeData({
  String planState = 'none',
  List<HomeActivity>? activities,
}) {
  return HomeData(
    userId: 'user-001',
    date: '2026-05-12',
    statusRing: _ring,
    recentActivities: activities ?? [_activity],
    weeklyStats: _weeklyStats,
    lifetimeStats: _lifetimeStats,
    planState: planState,
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

Future<void> _pump(
  WidgetTester tester,
  AsyncValue<HomeData> state, {
  String? currentUserId = 'user-001',
}) async {
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, __) => const HomeScreen(),
      ),
    ],
  );

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        homeProvider.overrideWith((_) => _resolve(state)),
        currentUserIdProvider.overrideWithValue(currentUserId),
      ],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  // Settle frames so FutureProvider resolves
  await tester.pumpAndSettle();
}

Future<HomeData> _resolve(AsyncValue<HomeData> state) {
  return switch (state) {
    AsyncData(:final value) => Future.value(value),
    AsyncError(:final error, :final stackTrace) =>
      Future.error(error, stackTrace),
    _ => Completer<HomeData>().future, // stays loading — never completes
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

void main() {
  testWidgets('renders status ring card', (tester) async {
    await _pump(tester, AsyncData(_makeHomeData()));

    // Ring labels
    expect(find.text('疲劳'), findsOneWidget);
    expect(find.text('TSB'), findsOneWidget);
    expect(find.text('负荷'), findsOneWidget);
  });

  testWidgets('renders weekly stats section', (tester) async {
    await _pump(tester, AsyncData(_makeHomeData()));

    expect(find.text('本周统计'), findsOneWidget);
    expect(find.text('里程'), findsOneWidget);
    expect(find.text('课次'), findsOneWidget);
  });

  testWidgets('renders activity list with name and commentary', (tester) async {
    await _pump(tester, AsyncData(_makeHomeData()));

    expect(find.text('最近活动'), findsOneWidget);
    expect(find.text('晨跑 10K'), findsOneWidget);
    expect(find.textContaining('节奏稳定'), findsOneWidget);
  });

  testWidgets('plan_state==none shows generate plan CTA', (tester) async {
    await _pump(tester, AsyncData(_makeHomeData(planState: 'none')));

    expect(find.text('生成个性化训练计划'), findsOneWidget);
  });

  testWidgets('plan_state==active hides generate plan CTA', (tester) async {
    await _pump(tester, AsyncData(_makeHomeData(planState: 'active')));

    expect(find.text('生成个性化训练计划'), findsNothing);
  });

  testWidgets('tapping CTA shows snackbar', (tester) async {
    await _pump(tester, AsyncData(_makeHomeData(planState: 'none')));

    await tester.tap(find.text('生成个性化训练计划'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.textContaining('v1.x 即将开放'), findsOneWidget);
  });

  testWidgets('empty activities shows 暂无近期活动', (tester) async {
    await _pump(tester, AsyncData(_makeHomeData(activities: [])));

    expect(find.text('暂无近期活动'), findsOneWidget);
  });

  testWidgets('loading state shows CircularProgressIndicator', (tester) async {
    // Use pump (not pumpAndSettle) so loading spinner stays
    final router = GoRouter(
      routes: [
        GoRoute(path: '/', builder: (_, __) => const HomeScreen()),
      ],
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          homeProvider.overrideWith(
            (_) => Completer<HomeData>().future,
          ),
          currentUserIdProvider.overrideWithValue('user-001'),
        ],
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pump(); // Let first frame build (loading state visible)

    expect(find.byType(CircularProgressIndicator), findsAtLeastNWidgets(1));
  });

  testWidgets('error state shows 加载失败', (tester) async {
    await _pump(
      tester,
      AsyncError(Exception('network error'), StackTrace.empty),
    );

    expect(find.text('加载失败'), findsOneWidget);
  });

  testWidgets('activity card tap navigates to detail route', (tester) async {
    String? navigatedTo;
    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (_, __) => const HomeScreen(),
        ),
        GoRoute(
          path: '/v2/activity/:id',
          builder: (_, state) {
            navigatedTo = state.pathParameters['id'];
            return const Scaffold(body: Text('detail'));
          },
        ),
      ],
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          homeProvider.overrideWith((_) => Future.value(_makeHomeData())),
          currentUserIdProvider.overrideWithValue('user-001'),
        ],
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('晨跑 10K'));
    await tester.pumpAndSettle();

    expect(navigatedTo, equals('ACT_001'));
  });
}
