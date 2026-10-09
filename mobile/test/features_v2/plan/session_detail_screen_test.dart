/// Widget tests for D3 SessionDetailScreen（结构化课表数据源）.
///
/// Coverage:
///   1. run 课渲染 → 课名 + 课表结构 steps
///   2. strength 课 → 力量动作清单 rows
///   3. 推送按钮点击 → 调 API (mock 验证 endpoint 调用)
///   4. 加载中 → CircularProgressIndicator
///   5. 错误态 → "加载失败"
///   6. 教练备注（notes_md 首行）渲染
///   7. 当日营养渲染
library;

import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/data/models/weekly_plan.dart';
import 'package:stride/features_v2/plan/providers/week_detail_provider.dart';
import 'package:stride/features_v2/plan/session_detail_screen.dart';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const _folder = '2026-05-11_05-17(W1基础)';

WeekDetailData _makeData(List<PlannedSession> sessions,
    {PlannedNutrition? nutrition}) {
  final content = WeeklyPlanContent(
    sessions: sessions,
    nutrition: nutrition == null ? const [] : [nutrition],
    coachNotes: '本周以有氧基础为主。',
  );
  return WeekDetailData(
    folder: _folder,
    dateFrom: '2026-05-11',
    dateTo: '2026-05-17',
    planTitle: 'W1 基础',
    planContent: content,
    days: [
      for (var i = 0; i < 7; i++)
        WeekDaySessions(
          date: '2026-05-${(11 + i).toString().padLeft(2, '0')}',
          sessions: content.sessionsOn('2026-05-${(11 + i).toString().padLeft(2, '0')}'),
        ),
    ],
  );
}

PlannedSession _easyRun() => const PlannedSession(
      date: '2026-05-12',
      sessionIndex: 0,
      kind: 'run',
      summary: '',
      spec: RunWorkoutSpec(
        name: '晨间轻松跑',
        note: null,
        blocks: [
          WorkoutBlock(steps: [
            WorkoutStep(
              stepKind: 'warmup',
              target: WorkoutTarget(kind: 'open'),
            ),
            WorkoutStep(
              stepKind: 'work',
              target: WorkoutTarget(kind: 'hr_bpm', low: 130, high: 150),
            ),
          ]),
        ],
      ),
      notesMd: '保持心率区间，别提速。\n第二行不显示。',
      totalDistanceM: 10000,
      totalDurationS: 3600,
    );

PlannedSession _strength() => const PlannedSession(
      date: '2026-05-12',
      sessionIndex: 0,
      kind: 'strength',
      summary: '核心力量',
      spec: StrengthWorkoutSpec(
        name: '核心力量',
        exercises: [
          StrengthExercise(
            displayName: '平板支撑',
            sets: 3,
            targetKind: 'time_s',
            targetValue: 60,
            restSeconds: 45,
          ),
        ],
      ),
      totalDurationS: 1800,
    );

class _MockStrideApi extends StrideApi {
  _MockStrideApi() : super(Dio());

  final List<({String user, String date, int sessionIndex})> pushCalls = [];

  @override
  Future<Map<String, dynamic>> pushPlannedSession(
    String user,
    String date,
    int sessionIndex, {
    String? targetDate,
  }) async {
    pushCalls.add((user: user, date: date, sessionIndex: sessionIndex));
    return {'ok': true};
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

Future<void> _pump(
  WidgetTester tester,
  AsyncValue<WeekDetailData> state, {
  _MockStrideApi? api,
}) async {
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => const SessionDetailScreen(
          folder: _folder,
          date: '2026-05-12',
          sessionIndex: 0,
        ),
      ),
    ],
  );

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        weekDetailProvider(_folder).overrideWith((_) => _resolve(state)),
        currentUserIdProvider.overrideWithValue('user-001'),
        if (api != null) strideApiProvider.overrideWithValue(api),
      ],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
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
    await _pump(tester, const AsyncLoading());
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsAtLeastNWidgets(1));
  });

  // ── 2. Error state ────────────────────────────────────────────────────────
  testWidgets('error state shows 加载失败', (tester) async {
    await _pump(tester, AsyncError(Exception('network'), StackTrace.empty));
    await tester.pumpAndSettle();
    expect(find.text('加载失败'), findsOneWidget);
  });

  // ── 3. Run session renders name, spec steps, coach note ──────────────────
  testWidgets('run session renders title, steps and coach note', (
    tester,
  ) async {
    await _pump(tester, AsyncData(_makeData([_easyRun()])));
    await tester.pumpAndSettle();

    expect(find.text('晨间轻松跑'), findsOneWidget);
    expect(find.text('课表结构'), findsOneWidget);
    expect(find.text('热身'), findsOneWidget);
    expect(find.text('主课'), findsOneWidget);
    expect(find.text('心率 130–150 bpm'), findsOneWidget);
    // 教练备注取 notes_md 首行。
    expect(find.text('保持心率区间，别提速。'), findsOneWidget);
  });

  // ── 4. Strength session renders exercise list ────────────────────────────
  testWidgets('strength session renders exercise rows', (tester) async {
    await _pump(tester, AsyncData(_makeData([_strength()])));
    await tester.pumpAndSettle();

    expect(find.text('力量动作清单'), findsOneWidget);
    expect(find.text('平板支撑'), findsOneWidget);
    expect(find.text('3×60s'), findsOneWidget);
  });

  // ── 5. Nutrition section renders when the day has one ────────────────────
  testWidgets('nutrition renders for the day', (tester) async {
    await _pump(
      tester,
      AsyncData(
        _makeData(
          [_easyRun()],
          nutrition: const PlannedNutrition(
            date: '2026-05-12',
            kcalTarget: 2600,
            meals: [
              PlannedMeal(name: '早餐', kcal: 600, itemsMd: '燕麦 + 香蕉'),
            ],
            notesMd: '长距离日前增加碳水。',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('当日营养'), findsOneWidget);
    expect(find.text('早餐'), findsOneWidget);
    expect(find.text('600 kcal'), findsOneWidget);
  });

  // ── 6. Push button calls the API ─────────────────────────────────────────
  testWidgets('push button calls the push endpoint', (tester) async {
    final api = _MockStrideApi();
    await _pump(tester, AsyncData(_makeData([_easyRun()])), api: api);
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(
      find.text('推送本节课'),
      100.0,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('推送本节课'), warnIfMissed: false);
    await tester.pumpAndSettle();

    expect(api.pushCalls, hasLength(1));
    expect(api.pushCalls.single.date, '2026-05-12');
    expect(api.pushCalls.single.sessionIndex, 0);
    expect(find.text('已推送到手表'), findsOneWidget);
  });
}
