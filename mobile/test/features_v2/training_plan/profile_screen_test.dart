import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/training_plan/models/running_profile.dart';
import 'package:stride/features_v2/training_plan/profile_screen.dart';

// ── Fake StrideApi ────────────────────────────────────────────────────────────

class FakeProfileApi extends StrideApi {
  FakeProfileApi() : super(Dio());

  bool postCalled = false;

  @override
  Future<RunningProfile> postRunningProfile(Map<String, dynamic> body) async {
    postCalled = true;
    return const RunningProfile(
      runningAge: RunningAge.oneToThreeYears,
      currentWeeklyKm: WeeklyKm.twentyToForty,
      pbs: [],
      injuries: [],
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

Widget buildProfileApp(FakeProfileApi api) {
  final router = GoRouter(
    routes: [
      GoRoute(path: '/', builder: (context, state) => const RunningProfileScreen()),
      GoRoute(
        path: '/v2/training-plan/history-sync',
        builder: (context, state) => const Scaffold(body: Text('history-sync')),
      ),
    ],
  );
  return ProviderScope(
    overrides: [
      strideApiProvider.overrideWithValue(api),
    ],
    child: MaterialApp.router(routerConfig: router),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  testWidgets('renders screen without crash', (tester) async {
    final api = FakeProfileApi();
    await tester.pumpWidget(buildProfileApp(api));
    await tester.pumpAndSettle();

    expect(find.text('跑步背景'), findsOneWidget);
    expect(find.text('跑龄'), findsOneWidget);
    expect(find.text('目前周跑量'), findsOneWidget);
  });

  testWidgets('skip button exists and navigates without calling API',
      (tester) async {
    final api = FakeProfileApi();
    await tester.pumpWidget(buildProfileApp(api));
    await tester.pumpAndSettle();

    // Tap the OutlinedButton 跳过 in the bottom bar
    await tester.tap(find.widgetWithText(OutlinedButton, '跳过'));
    await tester.pumpAndSettle();

    expect(api.postCalled, isFalse);
    expect(find.text('history-sync'), findsOneWidget);
  });

  testWidgets('all running age options are visible', (tester) async {
    final api = FakeProfileApi();
    await tester.pumpWidget(buildProfileApp(api));
    await tester.pumpAndSettle();

    expect(find.text('不足 6 个月'), findsOneWidget);
    expect(find.text('6 个月 ~ 1 年'), findsOneWidget);
    expect(find.text('1 ~ 3 年'), findsOneWidget);
    expect(find.text('3 年以上'), findsOneWidget);
  });

  testWidgets('next button disabled until age and weekly km selected',
      (tester) async {
    final api = FakeProfileApi();
    await tester.pumpWidget(buildProfileApp(api));
    await tester.pumpAndSettle();

    // Initially disabled
    final btn = tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, '下一步'),
    );
    expect(btn.onPressed, isNull);

    // Select running age
    await tester.tap(find.text('1 ~ 3 年'));
    await tester.pumpAndSettle();

    // Still disabled (no weekly km)
    final btn2 = tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, '下一步'),
    );
    expect(btn2.onPressed, isNull);

    // Select weekly km
    await tester.tap(find.text('20 ~ 40 km'));
    await tester.pumpAndSettle();

    // Now enabled
    final btn3 = tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, '下一步'),
    );
    expect(btn3.onPressed, isNotNull);
  });

  testWidgets('selecting 暂无 injury clears other selections', (tester) async {
    final api = FakeProfileApi();
    await tester.pumpWidget(buildProfileApp(api));
    await tester.pumpAndSettle();

    // Scroll 膝盖 into view and select it
    await tester.ensureVisible(find.widgetWithText(FilterChip, '膝盖'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('膝盖'), warnIfMissed: false);
    await tester.pumpAndSettle();

    // Scroll 暂无 into view and select it
    await tester.ensureVisible(find.widgetWithText(FilterChip, '暂无'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('暂无'), warnIfMissed: false);
    await tester.pumpAndSettle();

    // 暂无 chip is selected
    final chip = tester.widget<FilterChip>(
      find.widgetWithText(FilterChip, '暂无'),
    );
    expect(chip.selected, isTrue);

    // 膝盖 chip is deselected
    final kneeChip = tester.widget<FilterChip>(
      find.widgetWithText(FilterChip, '膝盖'),
    );
    expect(kneeChip.selected, isFalse);
  });
}
