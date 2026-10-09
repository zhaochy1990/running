import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/data/models/profile.dart';
import 'package:stride/features_v2/profile/profile_screen.dart';

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

// ── Pump helper ───────────────────────────────────────────────────────────────

Future<void> _pump(
  WidgetTester tester, {
  required MyProfile? profile,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        currentUserProvider.overrideWith((_) => Future.value(profile)),
      ],
      child: const MaterialApp(home: MeScreen()),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  testWidgets('shows display name and email', (tester) async {
    await _pump(tester, profile: _testProfile);

    expect(find.text('Test Runner'), findsOneWidget);
    expect(find.text('test@stride.cn'), findsOneWidget);
  });

  testWidgets('avatar shows first letter of display name', (tester) async {
    await _pump(tester, profile: _testProfile);

    // CircleAvatar with initial 'T'.
    expect(find.text('T'), findsOneWidget);
  });

  testWidgets('top bar title is 我', (tester) async {
    await _pump(tester, profile: _testProfile);

    expect(find.text('我'), findsOneWidget);
  });

  testWidgets('menu mirrors the miniprogram profile entries', (tester) async {
    await _pump(tester, profile: _testProfile);

    expect(find.text('手动同步'), findsOneWidget);
    expect(find.text('训练状态'), findsOneWidget);
    expect(find.text('赛事中心'), findsOneWidget);
    expect(find.text('我的比赛'), findsOneWidget);
    expect(find.text('手表管理'), findsOneWidget);
    expect(find.text('数据与状态'), findsOneWidget);
    expect(find.text('检查更新'), findsOneWidget);
  });

  testWidgets('watch subtitle shows 已绑定 when corosReady', (tester) async {
    await _pump(tester, profile: _testProfile);
    expect(find.text('已绑定'), findsOneWidget);
  });

  testWidgets('watch subtitle shows 未绑定 when not bound', (tester) async {
    await _pump(
      tester,
      profile: const MyProfile(
        id: 'user-123',
        displayName: 'Test Runner',
        onboarding: OnboardingState(corosReady: false, profileReady: true),
        profile: {'email': 'test@stride.cn'},
      ),
    );
    expect(find.text('未绑定'), findsOneWidget);
  });

  testWidgets('退出登录 button is present in list', (tester) async {
    await _pump(tester, profile: _testProfile);

    // May be off-screen in a short test viewport — scroll to find it.
    await tester.scrollUntilVisible(
      find.text('退出登录'),
      100.0,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('退出登录'), findsOneWidget);
  });

  testWidgets('退出登录 shows confirm dialog', (tester) async {
    await _pump(tester, profile: _testProfile);

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
  });

  testWidgets('renders with a null profile (still logged-in race)', (
    tester,
  ) async {
    await _pump(tester, profile: null);

    // Falls back to the email prefix of an empty email → 'U' avatar.
    expect(find.text('U'), findsOneWidget);
  });
}
