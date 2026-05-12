/// Widget tests for D6 PreTrainingScreen.
///
/// Coverage:
///   1. E 课渲染：课名 + 强度 pill 颜色 / 距离 / 配速区间
///   2. warmup_blocks 为空 → 默认 3 项清单
///   3. 启动按钮点击 → SnackBar 显示
///   4. 加载中 → CircularProgressIndicator
///   5. 错误态 → "加载失败"
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/core/theme/pill_colors.dart';
import 'package:stride/features_v2/plan/models/day_plan.dart';
import 'package:stride/features_v2/plan/pre_training_screen.dart';
import 'package:stride/features_v2/plan/providers/plan_day_provider.dart';

// ── Fixtures ──────────────────────────────────────────────────────────────

/// A minimal E-kind [DayPlan] for most tests.
DayPlan _makeEasyPlan({
  String? name,
  num? distanceM,
  num? durationSec,
  int? paceLow,
  int? paceHigh,
  int? hrLow,
  int? hrHigh,
  List<String>? warmupBlocks,
  String? nutritionPre,
}) {
  return DayPlan(
    date: '2026-05-12',
    sessionIndex: 0,
    kind: 'E',
    name: name ?? '晨间轻松跑',
    distanceM: distanceM ?? 10000,
    durationSec: durationSec,
    targetPaceLowSecPerKm: paceLow ?? 300,  // 5:00/km
    targetPaceHighSecPerKm: paceHigh ?? 330, // 5:30/km
    targetHrLow: hrLow ?? 130,
    targetHrHigh: hrHigh ?? 150,
    warmupBlocks: warmupBlocks,
    nutritionPre: nutritionPre,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

/// Pumps a [PreTrainingScreen] with [planDayProvider] overridden.
Future<void> _pump(
  WidgetTester tester,
  AsyncValue<DayPlan> state, {
  String date = '2026-05-12',
  int sessionIndex = 0,
}) async {
  final params = (date: date, sessionIndex: sessionIndex);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        planDayProvider(params).overrideWith((_) => _resolve(state)),
        currentUserIdProvider.overrideWithValue('user-001'),
      ],
      child: MaterialApp(
        home: PreTrainingScreen(date: date, sessionIndex: sessionIndex),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<DayPlan> _resolve(AsyncValue<DayPlan> state) {
  return switch (state) {
    AsyncData(:final value) => Future.value(value),
    AsyncError(:final error, :final stackTrace) =>
      Future.error(error, stackTrace),
    _ => Completer<DayPlan>().future, // loading — never resolves
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

void main() {
  // ── 1. E 课渲染 ──────────────────────────────────────────────────────────

  testWidgets('renders session name in card', (tester) async {
    await _pump(tester, AsyncData(_makeEasyPlan(name: '晨间轻松跑')));

    expect(find.text('晨间轻松跑'), findsOneWidget);
  });

  testWidgets('E-kind pill has green variant colors', (tester) async {
    await _pump(tester, AsyncData(_makeEasyPlan()));

    // Find the Container that carries the pill background
    final greenBg = PillColors.of(PillVariant.green).bg;
    final containerFinder = find.byWidgetPredicate((w) {
      if (w is! Container) return false;
      final deco = w.decoration;
      if (deco is! BoxDecoration) return false;
      return deco.color == greenBg;
    });
    expect(containerFinder, findsAtLeastNWidgets(1));
  });

  testWidgets('renders distance in km', (tester) async {
    // 10 000 m → "10.0" km
    await _pump(tester, AsyncData(_makeEasyPlan(distanceM: 10000)));

    expect(find.text('10.0'), findsOneWidget);
    expect(find.text('距离'), findsOneWidget);
  });

  testWidgets('renders pace range as formatted string', (tester) async {
    // 300 s/km = 5:00,  330 s/km = 5:30  →  "5:00–5:30"
    await _pump(
      tester,
      AsyncData(_makeEasyPlan(paceLow: 300, paceHigh: 330)),
    );

    expect(find.text('5:00–5:30'), findsOneWidget);
  });

  testWidgets('renders HR range when provided', (tester) async {
    await _pump(
      tester,
      AsyncData(_makeEasyPlan(hrLow: 130, hrHigh: 150)),
    );

    expect(find.textContaining('130'), findsAtLeastNWidgets(1));
    expect(find.textContaining('150'), findsAtLeastNWidgets(1));
  });

  testWidgets('top bar shows "训练前准备" title', (tester) async {
    await _pump(tester, AsyncData(_makeEasyPlan()));

    expect(find.text('训练前准备'), findsOneWidget);
  });

  // ── 2. Warmup defaults ───────────────────────────────────────────────────

  testWidgets('warmup_blocks null → shows default 3 items', (tester) async {
    await _pump(
      tester,
      AsyncData(_makeEasyPlan(warmupBlocks: null)),
    );

    expect(find.text('慢跑 5 分钟'), findsOneWidget);
    expect(find.text('动态拉伸 5 分钟'), findsOneWidget);
    expect(find.text('高抬腿 + 后踢腿各 20 个'), findsOneWidget);
  });

  testWidgets('warmup_blocks provided → shows custom items', (tester) async {
    await _pump(
      tester,
      AsyncData(_makeEasyPlan(warmupBlocks: ['原地小步跑 3 分钟', '髋绕环 20 个'])),
    );

    expect(find.text('原地小步跑 3 分钟'), findsOneWidget);
    expect(find.text('髋绕环 20 个'), findsOneWidget);
    // Default items must NOT appear
    expect(find.text('慢跑 5 分钟'), findsNothing);
  });

  testWidgets('checking a warmup item marks it with strikethrough', (tester) async {
    await _pump(
      tester,
      AsyncData(_makeEasyPlan(warmupBlocks: null)),
    );

    // Tap the first warmup item
    await tester.tap(find.text('慢跑 5 分钟'));
    await tester.pumpAndSettle();

    // After tap, the text should have lineThrough decoration
    final textWidget = tester.widget<Text>(find.text('慢跑 5 分钟'));
    expect(
      textWidget.style?.decoration,
      equals(TextDecoration.lineThrough),
    );
  });

  // ── 3. 启动训练按钮 → SnackBar ─────────────────────────────────────────

  testWidgets('tapping 启动训练 shows SnackBar', (tester) async {
    await _pump(tester, AsyncData(_makeEasyPlan()));

    await tester.tap(find.text('启动训练'));
    await tester.pump(); // let SnackBar animate in

    expect(find.text('请在手表上启动训练'), findsOneWidget);
  });

  // ── 4. Loading state ─────────────────────────────────────────────────────

  testWidgets('loading state shows CircularProgressIndicator', (tester) async {
    const params = (date: '2026-05-12', sessionIndex: 0);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          planDayProvider(params).overrideWith(
            (_) => Completer<DayPlan>().future,
          ),
          currentUserIdProvider.overrideWithValue('user-001'),
        ],
        child: const MaterialApp(
          home: PreTrainingScreen(date: '2026-05-12', sessionIndex: 0),
        ),
      ),
    );
    await tester.pump(); // first frame — loading visible

    expect(find.byType(CircularProgressIndicator), findsAtLeastNWidgets(1));
  });

  // ── 5. Error state ───────────────────────────────────────────────────────

  testWidgets('error state shows "加载失败"', (tester) async {
    await _pump(
      tester,
      AsyncError(Exception('network error'), StackTrace.empty),
    );

    expect(find.text('加载失败'), findsOneWidget);
  });

  // ── 6. Nutrition defaults ─────────────────────────────────────────────────

  testWidgets('nutritionPre null → shows default nutrition text', (tester) async {
    await _pump(
      tester,
      AsyncData(_makeEasyPlan(nutritionPre: null)),
    );

    expect(find.textContaining('训前 1-2 小时'), findsOneWidget);
  });

  testWidgets('nutritionPre provided → shows custom text', (tester) async {
    await _pump(
      tester,
      AsyncData(_makeEasyPlan(nutritionPre: '比赛日特供：赛前 45 分钟 2 颗枣 + 黑咖啡')),
    );

    expect(find.textContaining('比赛日特供'), findsOneWidget);
    // Default text must NOT appear
    expect(find.textContaining('训前 1-2 小时'), findsNothing);
  });

  // ── 7. Section headers ────────────────────────────────────────────────────

  testWidgets('renders section headers 热身 and 训前营养', (tester) async {
    await _pump(tester, AsyncData(_makeEasyPlan()));

    expect(find.text('热身'), findsOneWidget);
    expect(find.text('训前营养'), findsOneWidget);
  });
}
