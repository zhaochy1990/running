import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/training_plan/goal_screen.dart';
import 'package:stride/features_v2/training_plan/models/training_goal.dart';

// ── Fake StrideApi ────────────────────────────────────────────────────────────

class FakeStrideApi extends StrideApi {
  FakeStrideApi() : super(Dio());

  @override
  Future<TrainingGoal?> getTrainingGoal() async => null;

  @override
  Future<TrainingGoal> postTrainingGoal(Map<String, dynamic> body) async {
    return const TrainingGoal(
      goalId: 'goal-001',
      type: GoalType.health,
      weeklyTrainingDays: 4,
      availableTimeSlots: [TimeSlot.morning],
      strengthWillingness: StrengthWillingness.conditional,
    );
  }

  @override
  Future<TrainingGoal> putTrainingGoal(Map<String, dynamic> body) async {
    return postTrainingGoal(body);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

Widget buildGoalApp({FakeStrideApi? api}) {
  final fakeApi = api ?? FakeStrideApi();
  final router = GoRouter(
    routes: [
      GoRoute(path: '/', builder: (context, state) => const TrainingGoalScreen()),
      GoRoute(
        path: '/v2/training-plan/profile',
        builder: (context, state) => const Scaffold(body: Text('profile')),
      ),
    ],
  );
  return ProviderScope(
    overrides: [
      strideApiProvider.overrideWithValue(fakeApi),
    ],
    child: MaterialApp.router(routerConfig: router),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  testWidgets('renders screen without crash', (tester) async {
    await tester.pumpWidget(buildGoalApp());
    await tester.pumpAndSettle();

    expect(find.text('训练目标'), findsOneWidget);
    expect(find.text('目标类型'), findsOneWidget);
  });

  testWidgets('next button is disabled when nothing selected', (tester) async {
    await tester.pumpWidget(buildGoalApp());
    await tester.pumpAndSettle();

    final btn = tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, '下一步'),
    );
    expect(btn.onPressed, isNull);
  });

  testWidgets('selecting 备赛 reveals race fields', (tester) async {
    await tester.pumpWidget(buildGoalApp());
    await tester.pumpAndSettle();

    // Race fields should not be visible yet
    expect(find.text('比赛信息'), findsNothing);

    // Tap 备赛
    await tester.tap(find.text('备赛'));
    await tester.pumpAndSettle();

    // Race fields should now appear
    expect(find.text('比赛信息'), findsOneWidget);
    expect(find.text('全马'), findsOneWidget);
    expect(find.text('半马'), findsOneWidget);
  });

  testWidgets('all 5 goal type cards are rendered', (tester) async {
    await tester.pumpWidget(buildGoalApp());
    await tester.pumpAndSettle();

    expect(find.text('备赛'), findsOneWidget);
    expect(find.text('PB 突破'), findsOneWidget);
    expect(find.text('减脂塑形'), findsOneWidget);
    expect(find.text('健康跑'), findsOneWidget);
    expect(find.text('维持状态'), findsOneWidget);
  });

  testWidgets('button becomes enabled after filling required fields',
      (tester) async {
    await tester.pumpWidget(buildGoalApp());
    await tester.pumpAndSettle();

    // Select 健康跑
    await tester.tap(find.text('健康跑'));
    await tester.pumpAndSettle();

    // Select time slot 早晨 (scroll into view first)
    await tester.ensureVisible(find.text('早晨'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('早晨'), warnIfMissed: false);
    await tester.pumpAndSettle();

    // Select strength willingness 看情况 (may be off-screen)
    await tester.ensureVisible(find.text('看情况'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('看情况'), warnIfMissed: false);
    await tester.pumpAndSettle();

    final btn = tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, '下一步'),
    );
    expect(btn.onPressed, isNotNull);
  });
}
