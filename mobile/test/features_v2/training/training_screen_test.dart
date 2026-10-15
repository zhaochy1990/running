/// 训练 tab 空态卡片宽度回归（#540）：卡片必须占满可用宽（减去自身 margin），
/// 不允许缩到文本固有宽度（真机上呈半宽的根因）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/core/router/routes.dart';
import 'package:stride/core/theme/tokens.dart';
import 'package:stride/data/models/activity.dart';
import 'package:stride/data/models/weekly_plan.dart';
import 'package:stride/features_v2/training/providers/training_providers.dart';
import 'package:stride/features_v2/training/training_screen.dart';

WeeklyPlanDetail _emptyWeekPlan() => const WeeklyPlanDetail(
  planId: 'plan-1',
  weekName: '2026-05-11_05-17',
  dateFrom: '2026-05-11',
  dateTo: '2026-05-17',
  status: 'active',
  content: WeeklyPlanContent(sessions: [], nutrition: []),
);

void main() {
  testWidgets('empty-workout card spans the full available width', (
    tester,
  ) async {
    final router = GoRouter(
      routes: [
        GoRoute(path: '/', builder: (_, $) => const TrainingScreen()),
        GoRoute(
          path: Routes.planWeeks,
          builder: (_, $) => const Scaffold(body: Text('plan-stub')),
        ),
      ],
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          weeklyPlanProvider.overrideWith((_) => Future.value(_emptyWeekPlan())),
          dayActivitiesProvider.overrideWith((_, _) => const <Activity>[]),
          currentUserIdProvider.overrideWithValue('u-width'),
        ],
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('今日无训练安排'), findsOneWidget);
    // 卡片视觉体 = Container 链内的 DecoratedBox（外层是含 margin 的包装）。
    final cardRect = tester.getRect(
      find.descendant(
        of: find.ancestor(
          of: find.text('今日无训练安排'),
          matching: find.byWidgetPredicate(
            (w) => w is Container && w.decoration is BoxDecoration,
          ),
        ),
        matching: find.byType(DecoratedBox),
      ),
    );
    final viewportWidth =
        tester.view.physicalSize.width / tester.view.devicePixelRatio;
    expect(cardRect.width, viewportWidth - 2 * StrideTokens.spaceLg);
    expect(cardRect.left, StrideTokens.spaceLg);
  });
}
