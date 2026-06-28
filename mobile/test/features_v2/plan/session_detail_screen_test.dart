/// Widget tests for D3 SessionDetailScreen.
///
/// Coverage:
///   1. E 课渲染 → 配速 pill green + 距离 stat-row
///   2. strength 课 → 显示动作清单 section header
///   3. 推送按钮点击 → 调 API (mock 验证 endpoint URL)
///   4. 加载中 → CircularProgressIndicator
///   5. 错误态 → "加载失败"
///   6. 第二 stat row 渲染
///   7. 执行要点 + 训前营养 section headers
library;

import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/core/theme/pill_colors.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/data/models/plan.dart';
import 'package:stride/features_v2/plan/models/day_plan.dart';
import 'package:stride/features_v2/plan/providers/plan_day_provider.dart';
import 'package:stride/features_v2/plan/session_detail_screen.dart';

// ── Fixtures ──────────────────────────────────────────────────────────────────

DayPlan _makeEasyPlan({
  String? name,
  num? distanceM,
  num? durationSec,
  int? paceLow,
  int? paceHigh,
  int? hrLow,
  int? hrHigh,
}) {
  return DayPlan(
    date: '2026-05-12',
    sessionIndex: 0,
    kind: 'E',
    name: name ?? '晨间轻松跑',
    distanceM: distanceM ?? 10000,
    durationSec: durationSec ?? 3600,
    targetPaceLowSecPerKm: paceLow ?? 300,
    targetPaceHighSecPerKm: paceHigh ?? 330,
    targetHrLow: hrLow ?? 130,
    targetHrHigh: hrHigh ?? 150,
  );
}

DayPlan _makeStrengthPlan() {
  return const DayPlan(
    date: '2026-05-14',
    sessionIndex: 0,
    kind: 'strength',
    name: '力量 A',
    durationSec: 3000,
  );
}

// ── Mock StrideApi ─────────────────────────────────────────────────────────────

/// Records calls to [pushPlannedSession] for assertion.
class _MockStrideApi extends StrideApi {
  _MockStrideApi() : super(Dio());

  final List<({String userId, String date, int sessionIndex})> pushCalls = [];

  @override
  Future<Map<String, dynamic>> pushPlannedSession(
    String user,
    String date,
    int sessionIndex,
  ) async {
    pushCalls.add((userId: user, date: date, sessionIndex: sessionIndex));
    return {'status': 'ok'};
  }

  @override
  Future<PlanDaysResponse> getPlanDays(
    String user,
    String from,
    String to,
  ) async {
    // Return minimal plan day matching the date
    final session = PlannedSession(
      id: 1,
      date: from,
      sessionIndex: 0,
      kind: 'E',
      pushable: true,
      title: '晨间轻松跑',
      notes: '保持 Z2 心率，专注节奏。',
    );
    final day = PlanDay(date: from, sessions: [session]);
    return PlanDaysResponse(days: [day]);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

Future<void> _pump(
  WidgetTester tester,
  AsyncValue<DayPlan> planState, {
  String folder = '2026-05-11_05-17',
  String date = '2026-05-12',
  int sessionIndex = 0,
  _MockStrideApi? mockApi,
}) async {
  final params = (date: date, sessionIndex: sessionIndex);
  final api = mockApi ?? _MockStrideApi();

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        planDayProvider(params).overrideWith((_) => _resolve(planState)),
        currentUserIdProvider.overrideWithValue('user-001'),
        strideApiProvider.overrideWithValue(api),
      ],
      child: MaterialApp(
        home: SessionDetailScreen(
          folder: folder,
          date: date,
          sessionIndex: sessionIndex,
        ),
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
    _ => Completer<DayPlan>().future,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  // ── 1. E 课渲染 ─────────────────────────────────────────────────────────────

  testWidgets('renders session name in hero + summary card', (tester) async {
    await _pump(tester, AsyncData(_makeEasyPlan(name: '晨间轻松跑')));
    // Name appears twice post-wave-1: once in StrideScreenHero h1, once in
    // the _SummaryCard title. The duplicate is intentional until wave 2
    // collapses the summary card.
    expect(find.text('晨间轻松跑'), findsAtLeastNWidgets(1));
  });

  testWidgets('E-kind pill has green variant background', (tester) async {
    await _pump(tester, AsyncData(_makeEasyPlan()));

    final greenBg = PillColors.of(PillVariant.green).bg;
    final containerFinder = find.byWidgetPredicate((w) {
      if (w is! Container) return false;
      final deco = w.decoration;
      if (deco is! BoxDecoration) return false;
      return deco.color == greenBg;
    });
    expect(containerFinder, findsAtLeastNWidgets(1));
  });

  testWidgets('renders distance in km in stat row', (tester) async {
    await _pump(tester, AsyncData(_makeEasyPlan(distanceM: 10000)));
    // 10000m → "10.0"
    expect(find.text('10.0'), findsOneWidget);
    expect(find.text('距离'), findsOneWidget);
  });

  testWidgets('renders pace range string', (tester) async {
    await _pump(
      tester,
      AsyncData(_makeEasyPlan(paceLow: 300, paceHigh: 330)),
    );
    expect(find.text('5:00–5:30'), findsOneWidget);
  });

  // ── 2. Strength 课 → 动作清单 section ────────────────────────────────────────

  testWidgets('strength kind shows 力量动作清单 section header', (tester) async {
    await _pump(
      tester,
      AsyncData(_makeStrengthPlan()),
      date: '2026-05-14',
    );
    // The hero now occupies the top of the viewport, pushing the strength
    // section header below the fold. Look past Sliver offstage clipping.
    expect(
      find.text('力量动作清单', skipOffstage: false),
      findsOneWidget,
    );
  });

  testWidgets('E kind does NOT show 力量动作清单 section', (tester) async {
    await _pump(tester, AsyncData(_makeEasyPlan()));
    expect(find.text('力量动作清单'), findsNothing);
  });

  testWidgets('strength session shows placeholder when no exercise spec',
      (tester) async {
    await _pump(
      tester,
      AsyncData(_makeStrengthPlan()),
      date: '2026-05-14',
    );
    // Scroll down to expose the strength exercise list section.
    await tester.dragFrom(
      tester.getCenter(find.byType(ListView).first),
      const Offset(0, -300),
    );
    await tester.pumpAndSettle();
    expect(find.text('动作清单稍后同步'), findsOneWidget);
  });

  // ── 3. 推送按钮 → API 调用 ────────────────────────────────────────────────────

  testWidgets('tapping 推送本节课 calls pushPlannedSession with correct args',
      (tester) async {
    final mockApi = _MockStrideApi();
    await _pump(
      tester,
      AsyncData(_makeEasyPlan()),
      date: '2026-05-12',
      sessionIndex: 0,
      mockApi: mockApi,
    );

    await tester.tap(find.text('推送本节课'));
    await tester.pumpAndSettle();

    expect(mockApi.pushCalls, hasLength(1));
    expect(mockApi.pushCalls.first.userId, equals('user-001'));
    expect(mockApi.pushCalls.first.date, equals('2026-05-12'));
    expect(mockApi.pushCalls.first.sessionIndex, equals(0));
  });

  testWidgets('successful push shows 已推送到手表 SnackBar', (tester) async {
    final mockApi = _MockStrideApi();
    await _pump(
      tester,
      AsyncData(_makeEasyPlan()),
      mockApi: mockApi,
    );

    await tester.tap(find.text('推送本节课'));
    await tester.pump(); // let SnackBar appear

    expect(find.text('已推送到手表'), findsOneWidget);
  });

  // ── 4. Loading state ──────────────────────────────────────────────────────────

  testWidgets('loading state shows CircularProgressIndicator', (tester) async {
    const params = (date: '2026-05-12', sessionIndex: 0);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          planDayProvider(params).overrideWith(
            (_) => Completer<DayPlan>().future,
          ),
          currentUserIdProvider.overrideWithValue('user-001'),
          strideApiProvider.overrideWithValue(_MockStrideApi()),
        ],
        child: const MaterialApp(
          home: SessionDetailScreen(
            folder: '2026-05-11_05-17',
            date: '2026-05-12',
            sessionIndex: 0,
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsAtLeastNWidgets(1));
  });

  // ── 5. Error state ────────────────────────────────────────────────────────────

  testWidgets('error state shows 加载失败', (tester) async {
    await _pump(
      tester,
      AsyncError(Exception('network error'), StackTrace.empty),
    );
    // Post-wave-1 the error string appears both in the hero title and the
    // body's error column.
    expect(find.text('加载失败'), findsAtLeastNWidgets(1));
  });

  // ── 6. 第二 stat row ──────────────────────────────────────────────────────────

  testWidgets('renders secondary stat row with 心率区间 label', (tester) async {
    await _pump(tester, AsyncData(_makeEasyPlan(hrLow: 130, hrHigh: 150)));
    expect(find.text('心率区间'), findsOneWidget);
  });

  testWidgets('renders 卡路里估算 label in secondary row', (tester) async {
    await _pump(tester, AsyncData(_makeEasyPlan(distanceM: 10000)));
    expect(find.text('卡路里估算'), findsOneWidget);
  });

  // ── 7. Section headers ─────────────────────────────────────────────────────────

  testWidgets('shows 执行要点 and 训前营养 section headers', (tester) async {
    await _pump(tester, AsyncData(_makeEasyPlan()));
    expect(find.text('执行要点'), findsOneWidget);
    expect(find.text('训前营养'), findsOneWidget);
  });

  testWidgets('top bar title shows weekday and kind label', (tester) async {
    await _pump(tester, AsyncData(_makeEasyPlan()));
    // Date 2026-05-12 is Tuesday → weekdayCN → 周二. Kind 'E' falls back to
    // the upper-cased raw code per DayPlan.kindLabel.
    expect(find.text('周二 · E'), findsOneWidget);
  });

  // ── 8. Bottom buttons ─────────────────────────────────────────────────────────

  testWidgets('renders 训练前准备 and 推送本节课 buttons', (tester) async {
    await _pump(tester, AsyncData(_makeEasyPlan()));
    expect(find.text('训练前准备'), findsOneWidget);
    expect(find.text('推送本节课'), findsOneWidget);
  });
}
