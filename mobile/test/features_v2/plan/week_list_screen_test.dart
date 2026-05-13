/// Widget tests for D2a WeekListScreen.
///
/// Coverage:
///   1. mock provider 注入 3 周 → 3 张卡渲染
///   2. 卡点击触发 push 到 /v2/plan/weeks/:folder（mock router 验证）
///   3. 加载中 → CircularProgressIndicator
///   4. 错误态 → "加载失败"
///   5. 本周 tab: 只显示 inProgress 周
///   6. 历史 tab: 显示所有周
///   7. 下周 tab: 点击显示 SnackBar
///   8. 无计划周 → FAB 显示
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/core/router/routes_v2.dart';
import 'package:stride/features_v2/plan/models/week_list_item.dart';
import 'package:stride/features_v2/plan/providers/week_list_provider.dart';
import 'package:stride/features_v2/plan/week_list_screen.dart';

// ── Fixtures ──────────────────────────────────────────────────────────────────

WeekListItem _makeItem({
  required String folder,
  required String dateFrom,
  required String dateTo,
  WeekStatus status = WeekStatus.inProgress,
  bool hasPlan = true,
  String? planTitle,
  String? weekLabel,
  List<String?>? miniCalendar,
  int? totalSessions,
  num? weeklyDistanceM,
  num? weeklyDurationS,
}) {
  return WeekListItem(
    folder: folder,
    dateFrom: dateFrom,
    dateTo: dateTo,
    status: status,
    hasPlan: hasPlan,
    planTitle: planTitle,
    weekLabel: weekLabel,
    miniCalendar: miniCalendar,
    totalSessions: totalSessions,
    weeklyDistanceM: weeklyDistanceM,
    weeklyDurationS: weeklyDurationS,
  );
}

final _week1 = _makeItem(
  folder: '2026-05-11_05-17(W1基础)',
  dateFrom: '2026-05-11',
  dateTo: '2026-05-17',
  status: WeekStatus.inProgress,
  hasPlan: true,
  planTitle: 'W1 基础',
  weekLabel: '本周',
  miniCalendar: ['E', 'REST', 'T', 'E', 'REST', 'M', 'REST'],
  totalSessions: 4,
  weeklyDistanceM: 42000,
  weeklyDurationS: 14400,
);

final _week2 = _makeItem(
  folder: '2026-05-04_05-10(W0)',
  dateFrom: '2026-05-04',
  dateTo: '2026-05-10',
  status: WeekStatus.completed,
  hasPlan: true,
  planTitle: 'W0 适应',
);

final _week3 = _makeItem(
  folder: '2026-04-27_05-03(恢复)',
  dateFrom: '2026-04-27',
  dateTo: '2026-05-03',
  status: WeekStatus.completed,
  hasPlan: true,
  planTitle: '赛后恢复',
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Captured navigation calls.
final _pushedRoutes = <String>[];

GoRouter _makeRouter() {
  _pushedRoutes.clear();
  return GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => const WeekListScreen(),
      ),
      GoRoute(
        path: RoutesV2.weekDetailPattern,
        builder: (_, state) {
          _pushedRoutes.add('/v2/plan/weeks/${state.pathParameters['folder']}');
          return const Scaffold(body: Text('week-detail'));
        },
      ),
    ],
  );
}

Future<void> _pump(
  WidgetTester tester,
  AsyncValue<List<WeekListItem>> state,
) async {
  final router = _makeRouter();

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        weekListProvider.overrideWith((_) => _resolve(state)),
        currentUserIdProvider.overrideWithValue('user-001'),
      ],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
}

Future<List<WeekListItem>> _resolve(AsyncValue<List<WeekListItem>> state) {
  return switch (state) {
    AsyncData(:final value) => Future.value(value),
    AsyncError(:final error, :final stackTrace) =>
      Future.error(error, stackTrace),
    _ => Completer<List<WeekListItem>>().future,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  // ── 1. Loading state ──────────────────────────────────────────────────────
  testWidgets('loading state shows CircularProgressIndicator', (tester) async {
    final router = _makeRouter();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          weekListProvider.overrideWith(
            (_) => Completer<List<WeekListItem>>().future,
          ),
          currentUserIdProvider.overrideWithValue('user-001'),
        ],
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsAtLeastNWidgets(1));
  });

  // ── 2. Error state ────────────────────────────────────────────────────────
  testWidgets('error state shows 加载失败', (tester) async {
    await _pump(
      tester,
      AsyncError(Exception('network'), StackTrace.empty),
    );
    expect(find.text('加载失败'), findsOneWidget);
  });

  // ── 3. 3 weeks → 3 cards rendered (历史 tab) ─────────────────────────────
  testWidgets('history tab renders all 3 week cards', (tester) async {
    await _pump(
      tester,
      AsyncData([_week1, _week2, _week3]),
    );

    // Switch to 历史 tab.
    await tester.tap(find.text('历史'));
    await tester.pumpAndSettle();

    // _week1 has weekLabel='本周' → displayed as header label
    // _week2 has no weekLabel, planTitle='W0 适应' → displayed as header label
    // _week3 has no weekLabel, planTitle='赛后恢复' → displayed as header label
    expect(find.text('本周'), findsAtLeastNWidgets(1));
    expect(find.text('W0 适应'), findsOneWidget);
    expect(find.text('赛后恢复'), findsOneWidget);
  });

  // ── 4. Card tap → pushes to week detail route ────────────────────────────
  testWidgets('tapping week card navigates to week detail', (tester) async {
    await _pump(
      tester,
      AsyncData([_week1, _week2, _week3]),
    );

    // Switch to 历史 tab to see all weeks.
    await tester.tap(find.text('历史'));
    await tester.pumpAndSettle();

    // Tap the _week2 card (W0 适应) which has planTitle as header label.
    await tester.tap(find.text('W0 适应'));
    await tester.pumpAndSettle();

    expect(_pushedRoutes, contains(contains(_week2.folder)));
  });

  // ── 5. 本周 tab: shows only in-progress week ─────────────────────────────
  testWidgets('本周 tab shows only the in-progress week', (tester) async {
    await _pump(
      tester,
      AsyncData([_week1, _week2, _week3]),
    );

    // 本周 is default (index 0).
    // _week1 displays as '本周' (its weekLabel), not its planTitle.
    expect(find.text('本周'), findsAtLeastNWidgets(1));
    // Completed weeks should not appear in 本周 tab.
    expect(find.text('W0 适应'), findsNothing);
    expect(find.text('赛后恢复'), findsNothing);
  });

  // ── 6. 下周 tab → SnackBar ────────────────────────────────────────────────
  testWidgets('下周 tab shows snackbar', (tester) async {
    await _pump(
      tester,
      AsyncData([_week1]),
    );

    await tester.tap(find.text('下周'));
    await tester.pump();

    expect(find.text('下周计划 v1.x 即将开放'), findsOneWidget);
  });

  // ── 7. FAB shown when current week has no plan ────────────────────────────
  testWidgets('FAB shown when in-progress week has no plan', (tester) async {
    final noPlanWeek = _makeItem(
      folder: '2026-05-11_05-17(W1)',
      dateFrom: '2026-05-11',
      dateTo: '2026-05-17',
      status: WeekStatus.inProgress,
      hasPlan: false,
    );

    await _pump(tester, AsyncData([noPlanWeek]));

    expect(find.text('生成本周计划'), findsOneWidget);
  });

  // ── 8. FAB hidden when current week has plan ──────────────────────────────
  testWidgets('FAB hidden when in-progress week has plan', (tester) async {
    await _pump(tester, AsyncData([_week1]));
    expect(find.text('生成本周计划'), findsNothing);
  });

  // ── 9. Mini-calendar blocks rendered ─────────────────────────────────────
  testWidgets('week card with mini-calendar shows day labels', (tester) async {
    await _pump(tester, AsyncData([_week1]));

    // Day labels 一–日 should appear in the mini-calendar.
    expect(find.text('一'), findsAtLeastNWidgets(1));
    expect(find.text('日'), findsAtLeastNWidgets(1));
  });

  // ── 10. Top bar title ─────────────────────────────────────────────────────
  testWidgets('top bar shows 训练 title', (tester) async {
    await _pump(tester, AsyncData([_week1]));
    expect(find.text('训练'), findsOneWidget);
  });
}
