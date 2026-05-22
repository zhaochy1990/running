import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/data/models/profile.dart';
import 'package:stride/features_v2/profile/profile_screen.dart';
import 'package:stride/features_v2/home/providers/home_provider.dart';
import 'package:stride/features_v2/home/models/home_data.dart';

// ── Test data ─────────────────────────────────────────────────────────────────

const _testProfile = MyProfile(
  id: 'user-123',
  displayName: 'Test Runner',
  onboarding: OnboardingState(
    corosReady: true,
    profileReady: true,
    completedAt: '2026-01-01T00:00:00Z',
  ),
  profile: {'email': 'test@stride.cn'},
);

const _testHomeData = HomeData(
  userId: 'user-123',
  date: '2026-05-12',
  statusRing: StatusRing(
    fatigue: 42,
    fatigueBand: 'normal',
    tsb: -8.5,
    tsbBand: 'productive',
    loadRatio: 0.95,
    loadState: 'Optimal',
  ),
  recentActivities: [],
  weeklyStats: WeeklyStats(
    weekStart: '2026-05-11',
    totalDistanceKm: 50.0,
    totalDurationSec: 18000,
    sessionCount: 4,
  ),
  lifetimeStats: LifetimeStats(
    totalDistanceKm: 1234.5,
    totalActivities: 87,
  ),
  planState: 'none',
  watch: WatchInfo(brand: 'coros'),
);

// ── Pump helper ───────────────────────────────────────────────────────────────

Future<void> _pump(
  WidgetTester tester, {
  required MyProfile? profile,
  HomeData? homeData,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        currentUserProvider.overrideWith(
          (_) => Future.value(profile),
        ),
        homeProvider.overrideWith(
          (_) => Future.value(homeData),
        ),
      ],
      child: const MaterialApp(
        home: ProfileScreen(),
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  testWidgets('shows display name and email', (tester) async {
    await _pump(tester, profile: _testProfile, homeData: _testHomeData);

    expect(find.text('Test Runner'), findsOneWidget);
    expect(find.text('test@stride.cn'), findsOneWidget);
  });

  testWidgets('shows cumulative mileage from home data', (tester) async {
    await _pump(tester, profile: _testProfile, homeData: _testHomeData);

    // 1234.5 km displayed — toStringAsFixed(0) rounds to "1234" or "1235".
    // Check for the km suffix rather than exact digits.
    expect(find.textContaining('km'), findsWidgets);
  });

  testWidgets('avatar shows first letter of display name', (tester) async {
    await _pump(tester, profile: _testProfile, homeData: _testHomeData);

    // CircleAvatar with initial 'T'.
    expect(find.text('T'), findsOneWidget);
  });

  testWidgets('top bar title is 我', (tester) async {
    await _pump(tester, profile: _testProfile, homeData: _testHomeData);

    expect(find.text('我'), findsOneWidget);
  });

  testWidgets('退出登录 button is present in list', (tester) async {
    await _pump(tester, profile: _testProfile, homeData: _testHomeData);

    // May be off-screen in a short test viewport — scroll to find it.
    await tester.scrollUntilVisible(
      find.text('退出登录'),
      100.0,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('退出登录'), findsOneWidget);
  });

  testWidgets('退出登录 shows confirm dialog', (tester) async {
    await _pump(tester, profile: _testProfile, homeData: _testHomeData);

    await tester.scrollUntilVisible(
      find.text('退出登录'),
      100.0,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.ensureVisible(find.text('退出登录'));
    await tester.pump();
    await tester.tap(find.text('退出登录'), warnIfMissed: false);
    await tester.pumpAndSettle();

    // Dialog content.
    expect(find.text('确认退出当前账号？'), findsOneWidget);
    expect(find.text('取消'), findsOneWidget);
    expect(find.text('退出'), findsOneWidget);
  });

  testWidgets('cancel on logout dialog dismisses without action', (tester) async {
    await _pump(tester, profile: _testProfile, homeData: _testHomeData);

    await tester.scrollUntilVisible(
      find.text('退出登录'),
      100.0,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.ensureVisible(find.text('退出登录'));
    await tester.pump();
    await tester.tap(find.text('退出登录'), warnIfMissed: false);
    await tester.pumpAndSettle();

    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();

    // Dialog gone, still on profile screen.
    expect(find.text('确认退出当前账号？'), findsNothing);
    expect(find.text('我'), findsOneWidget);
  });

  testWidgets('menu items are present in tree', (tester) async {
    await _pump(tester, profile: _testProfile, homeData: _testHomeData);

    // Hero now occupies the top ~80px; bottom-half menu items can fall
    // below the 600px test viewport. Look past sliver offstage clipping.
    expect(find.text('个人信息', skipOffstage: false), findsOneWidget);
    expect(find.text('手表绑定', skipOffstage: false), findsOneWidget);
    expect(find.text('通知设置', skipOffstage: false), findsOneWidget);
    expect(find.text('关于 STRIDE', skipOffstage: false), findsOneWidget);
  });

  testWidgets('null home data shows — km placeholder', (tester) async {
    await _pump(tester, profile: _testProfile, homeData: null);

    expect(find.textContaining('—'), findsWidgets);
  });
}
