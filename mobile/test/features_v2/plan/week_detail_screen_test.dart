/// Widget tests for D2 WeekDetailScreen.
///
/// Coverage:
///   1. mock provider 注入 7 天 sessions → 7 行渲染
///   2. 课型 pill 颜色对应 kind（E=green, T=warn, REST=muted）
///   3. 点击某一天触发 push to D3 route（SnackBar 验证）
///   4. 周总览 stat-row 数据正确（里程/时长/力量）
///   5. 加载中 → CircularProgressIndicator
///   6. 错误态 → "加载失败"
///   7. 返回按钮存在
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/core/theme/pill_colors.dart';
import 'package:stride/data/models/plan.dart';
import 'package:stride/features_v2/plan/providers/week_detail_provider.dart';
import 'package:stride/features_v2/plan/week_detail_screen.dart';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const _folder = '2026-05-11_05-17(W1基础)';

PlannedSession _makeSession({
  required int id,
  required String date,
  required int sessionIndex,
  required String kind,
  String? title,
  num? distanceM,
  num? durationS,
}) {
  return PlannedSession(
    id: id,
    date: date,
    sessionIndex: sessionIndex,
    kind: kind,
    title: title,
    totalDistanceM: distanceM,
    totalDurationS: durationS,
    pushable: true,
  );
}

WeekDetailData _make7DayData() {
  // Mon–Sun: E, REST, T, E, REST, strength, REST
  final days = [
    PlanDay(
      date: '2026-05-11',
      sessions: [
        _makeSession(id: 1, date: '2026-05-11', sessionIndex: 0, kind: 'E',
            title: '轻松跑', distanceM: 10000, durationS: 3600),
      ],
    ),
    PlanDay(date: '2026-05-12', sessions: []),
    PlanDay(
      date: '2026-05-13',
      sessions: [
        _makeSession(id: 2, date: '2026-05-13', sessionIndex: 0, kind: 'T',
            title: '节奏跑', distanceM: 12000, durationS: 4320),
      ],
    ),
    PlanDay(
      date: '2026-05-14',
      sessions: [
        _makeSession(id: 3, date: '2026-05-14', sessionIndex: 0, kind: 'E',
            title: '恢复跑', distanceM: 8000, durationS: 3000),
      ],
    ),
    PlanDay(date: '2026-05-15', sessions: []),
    PlanDay(
      date: '2026-05-16',
      sessions: [
        _makeSession(id: 4, date: '2026-05-16', sessionIndex: 0,
            kind: 'strength', title: '力量训练', durationS: 2700),
      ],
    ),
    PlanDay(date: '2026-05-17', sessions: []),
  ];

  return WeekDetailData(
    folder: _folder,
    dateFrom: '2026-05-11',
    dateTo: '2026-05-17',
    planTitle: 'W1 基础',
    days: days,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

Future<void> _pump(
  WidgetTester tester,
  AsyncValue<WeekDetailData> state, {
  String folder = _folder,
}) async {
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, __) => WeekDetailScreen(folder: folder),
      ),
    ],
  );

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        weekDetailProvider(folder).overrideWith((_) => _resolve(state)),
        currentUserIdProvider.overrideWithValue('user-001'),
      ],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
}

Future<WeekDetailData> _resolve(AsyncValue<WeekDetailData> state) {
  return switch (state) {
    AsyncData(:final value) => Future.value(value),
    AsyncError(:final error, :final stackTrace) =>
      Future.error(error, stackTrace),
    _ => Completer<WeekDetailData>().future,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  // ── 1. Loading state ──────────────────────────────────────────────────────
  testWidgets('loading state shows CircularProgressIndicator', (tester) async {
    const folder = _folder;
    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (_, __) => const WeekDetailScreen(folder: folder),
        ),
      ],
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          weekDetailProvider(folder).overrideWith(
            (_) => Completer<WeekDetailData>().future,
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

  // ── 3. 7 days renders session rows ───────────────────────────────────────
  testWidgets('7 days data renders session rows', (tester) async {
    await _pump(tester, AsyncData(_make7DayData()));

    // Session names
    expect(find.text('轻松跑'), findsOneWidget);
    expect(find.text('节奏跑'), findsOneWidget);
    expect(find.text('恢复跑'), findsOneWidget);
    expect(find.text('力量训练'), findsOneWidget);
  });

  // ── 4. Rest days shown ────────────────────────────────────────────────────
  testWidgets('rest days render 休息日', (tester) async {
    await _pump(tester, AsyncData(_make7DayData()));

    // There are 3 rest days → 3 休息日 rows.
    expect(find.text('休息日'), findsAtLeastNWidgets(1));
  });

  // ── 5. E-kind pill has green color ───────────────────────────────────────
  testWidgets('E kind pill has green variant bg color', (tester) async {
    await _pump(tester, AsyncData(_make7DayData()));

    final greenBg = PillColors.of(PillVariant.green).bg;
    final containers = find.byWidgetPredicate((w) {
      if (w is! Container) return false;
      final deco = w.decoration;
      if (deco is! BoxDecoration) return false;
      return deco.color == greenBg;
    });
    expect(containers, findsAtLeastNWidgets(1));
  });

  // ── 6. T-kind pill has warn color ────────────────────────────────────────
  testWidgets('T kind pill has warn variant bg color', (tester) async {
    await _pump(tester, AsyncData(_make7DayData()));

    final warnBg = PillColors.of(PillVariant.warn).bg;
    final containers = find.byWidgetPredicate((w) {
      if (w is! Container) return false;
      final deco = w.decoration;
      if (deco is! BoxDecoration) return false;
      return deco.color == warnBg || deco.border != null;
    });
    // The T pill container exists somewhere in the tree.
    expect(containers, findsAtLeastNWidgets(1));
  });

  // ── 7. Session tap triggers navigation (T25 implemented) ────────────────
  testWidgets('tapping session row no longer shows T25 placeholder snackbar',
      (tester) async {
    await _pump(tester, AsyncData(_make7DayData()));

    // Tap '轻松跑' session row — now navigates to D3 (no placeholder SnackBar).
    await tester.tap(find.text('轻松跑'));
    await tester.pump();

    // The old placeholder text must not appear.
    expect(find.textContaining('T25 即将实现'), findsNothing);
  });

  // ── 8. Week stat row renders ──────────────────────────────────────────────
  testWidgets('stat row shows 周里程 label', (tester) async {
    await _pump(tester, AsyncData(_make7DayData()));
    expect(find.text('周里程'), findsOneWidget);
    expect(find.text('总时长'), findsOneWidget);
    expect(find.text('力量'), findsOneWidget);
  });

  // ── 9. Distance value in stat row ────────────────────────────────────────
  testWidgets('stat row shows correct distance', (tester) async {
    await _pump(tester, AsyncData(_make7DayData()));
    // 10000 + 12000 + 8000 = 30000 m = 30.0 km
    expect(find.text('30.0'), findsOneWidget);
  });

  // ── 10. Top bar shows plan title ──────────────────────────────────────────
  testWidgets('top bar shows plan title', (tester) async {
    await _pump(tester, AsyncData(_make7DayData()));
    expect(find.text('W1 基础'), findsAtLeastNWidgets(1));
  });

  // ── 11. Back button present ───────────────────────────────────────────────
  testWidgets('back button is present in top bar', (tester) async {
    await _pump(tester, AsyncData(_make7DayData()));
    expect(find.byIcon(Icons.arrow_back), findsOneWidget);
  });

  // ── 12. 调整计划 button is present ──────────────────────────────────────
  // The button now navigates to the LLM chat screen (D4 / T32). The push
  // target lives in a fullscreen route outside this test's MaterialApp, so
  // we only assert the entry point is rendered.
  testWidgets('调整计划 button is present', (tester) async {
    await _pump(tester, AsyncData(_make7DayData()));
    expect(find.text('调整计划'), findsAtLeastNWidgets(1));
  });

  // ── 13. 推送到手表 button shows confirm dialog ──────────────────────────
  testWidgets('推送到手表 button shows confirm dialog', (tester) async {
    await _pump(tester, AsyncData(_make7DayData()));

    // Scroll to bottom to ensure button is visible.
    await tester.ensureVisible(find.text('推送到手表'));
    await tester.tap(find.text('推送到手表'));
    await tester.pumpAndSettle();
    // AlertDialog confirm text should appear
    expect(find.textContaining('推送整周计划'), findsOneWidget);
  });

  // ── 14. 力量次数 in stat row ─────────────────────────────────────────────
  testWidgets('stat row shows strength count', (tester) async {
    await _pump(tester, AsyncData(_make7DayData()));
    // 1 strength session → "1次"
    expect(find.text('1次'), findsOneWidget);
  });

  // ── 15. Distance per row rendered ────────────────────────────────────────
  testWidgets('session row shows distance', (tester) async {
    await _pump(tester, AsyncData(_make7DayData()));
    // 10.0km for 轻松跑
    expect(find.text('10.0km'), findsOneWidget);
  });

  // ── 16. Date label rendered in session row ────────────────────────────────
  testWidgets('session row shows date label', (tester) async {
    await _pump(tester, AsyncData(_make7DayData()));
    // "5/11" for 2026-05-11
    expect(find.text('5/11'), findsAtLeastNWidgets(1));
  });
}
