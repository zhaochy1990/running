/// Widget tests for D9 WeekReviewScreen.
///
/// Uses provider overrides so no real HTTP calls are made.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/review/models/week_review.dart';
import 'package:stride/features_v2/review/providers/week_review_provider.dart';
import 'package:stride/features_v2/review/week_review_screen.dart';

const _folder = '2026-05-04_05-10(W1)';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const _summary = WeekSummary(
  totalDistanceKm: 45.2,
  totalDurationSec: 16200,
  totalSessionsPlanned: 5,
  totalSessionsCompleted: 4,
  completionRate: 0.8,
  strengthSessionsCompleted: 1,
  avgRpe: 6.0,
);

final _tsbSeries = [
  const TsbPoint(date: '2026-05-04', tsb: -10.0, ati: 50.0, cti: 40.0),
  const TsbPoint(date: '2026-05-05', tsb: -12.0, ati: 52.0, cti: 40.0),
  const TsbPoint(date: '2026-05-06', tsb: -11.0, ati: 51.0, cti: 40.0),
  const TsbPoint(date: '2026-05-07', tsb: -10.5, ati: 50.5, cti: 40.0),
  const TsbPoint(date: '2026-05-08', tsb: -13.0, ati: 53.0, cti: 40.0),
  const TsbPoint(date: '2026-05-09', tsb: -12.5, ati: 52.5, cti: 40.0),
  const TsbPoint(date: '2026-05-10', tsb: -11.5, ati: 51.5, cti: 40.0),
];

final _sessions = [
  const SessionReview(
    date: '2026-05-05',
    sessionIndex: 0,
    plannedSummary: 'E 10K 有氧',
    plannedKind: 'run',
    plannedDistanceM: 10000,
    completed: true,
    actualLabelId: 'ACT001',
    actualDistanceM: 9800,
    actualDurationSec: 3540,
    actualAvgHr: 148,
    rpe: 5,
    moodTags: ['状态好'],
    adherencePct: 98,
  ),
  const SessionReview(
    date: '2026-05-08',
    sessionIndex: 0,
    plannedSummary: '节奏跑 8K',
    plannedKind: 'run',
    plannedDistanceM: 8000,
    completed: false,
  ),
];

final _insights = [
  const Insight(type: 'completion', level: InsightLevel.neutral, text: '本周完成率 80%，整体尚可。'),
  const Insight(type: 'load', level: InsightLevel.neutral, text: 'TSB 处于正常范围。'),
  const Insight(type: 'rpe', level: InsightLevel.neutral, text: '平均 RPE 6.0，强度适中。'),
];

final _highlights = [
  const ActivityHighlight(
    labelId: 'ACT001',
    date: '2026-05-05',
    name: 'Easy Run',
    commentaryExcerpt: '轻松有氧节奏控制良好。',
  ),
];

const _nextWeek = NextWeekPreview(
  folder: '2026-05-11_05-17(W2)',
  planTitle: 'W2 渐进负荷',
  totalPlannedDistanceKm: 52.0,
  sessionsCount: 5,
  keySessionSummary: '周六 18K 有氧长跑',
);

WeekReview _fullReview({NextWeekPreview? nextWeek = _nextWeek}) => WeekReview(
      folder: _folder,
      dateFrom: '2026-05-04',
      dateTo: '2026-05-10',
      summary: _summary,
      tsbSeries: _tsbSeries,
      sessions: _sessions,
      activityHighlights: _highlights,
      insights: _insights,
      nextWeekPreview: nextWeek,
    );

// ── Helpers ───────────────────────────────────────────────────────────────────

Future<WeekReview> _resolve(AsyncValue<WeekReview> state) => switch (state) {
      AsyncData(:final value) => Future.value(value),
      AsyncError(:final error, :final stackTrace) =>
        Future.error(error, stackTrace),
      _ => Completer<WeekReview>().future,
    };

Future<void> _pump(
  WidgetTester tester,
  AsyncValue<WeekReview> state,
) async {
  // Use a tall surface so the entire ListView is laid out and all children
  // are built — avoids needing skipOffstage:false for bottom items.
  tester.view.physicalSize = const Size(400, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        weekReviewProvider(_folder)
            .overrideWith((_) => _resolve(state)),
      ],
      child: const MaterialApp(
        home: WeekReviewScreen(folder: _folder),
      ),
    ),
  );
  await tester.pump();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  group('WeekReviewScreen — full data', () {
    testWidgets('stat-row shows completion rate, distance, duration', (tester) async {
      await _pump(tester, AsyncData(_fullReview()));

      // Completion rate
      expect(find.text('80%'), findsOneWidget);
      // Distance
      expect(find.text('45.2'), findsOneWidget);
      // Duration: 16200s = 4h30m
      expect(find.text('4h30m'), findsOneWidget);
    });

    testWidgets('shows correct session count cards', (tester) async {
      await _pump(tester, AsyncData(_fullReview()));

      // Two planned sessions → two session cards with their summaries
      expect(find.text('E 10K 有氧'), findsOneWidget);
      expect(find.text('节奏跑 8K'), findsOneWidget);
    });

    testWidgets('completed session shows 已完成 pill', (tester) async {
      await _pump(tester, AsyncData(_fullReview()));
      expect(find.text('已完成'), findsOneWidget);
    });

    testWidgets('incomplete session shows 未完成 pill', (tester) async {
      await _pump(tester, AsyncData(_fullReview()));
      expect(find.text('未完成'), findsOneWidget);
    });

    testWidgets('insights renders correct pill count', (tester) async {
      await _pump(tester, AsyncData(_fullReview()));

      // Use skipOffstage:false so widgets scrolled off the test viewport are included.
      // '完成率' also appears in the stat-row label, so findsAtLeastNWidgets(1).
      expect(find.text('完成率'), findsAtLeastNWidgets(1)); // also in stat-row label
      expect(find.text('负荷'), findsOneWidget);
      expect(find.text('强度'), findsOneWidget);
    });

    testWidgets('next week preview card shows plan title', (tester) async {
      await _pump(tester, AsyncData(_fullReview()));
      expect(find.text('W2 渐进负荷'), findsOneWidget);
    });

    testWidgets('activity highlight shows activity name', (tester) async {
      await _pump(tester, AsyncData(_fullReview()));
      expect(find.text('Easy Run'), findsOneWidget);
    });
  });

  group('WeekReviewScreen — no next week preview', () {
    testWidgets('shows 下周计划尚未生成 when next_week_preview is null', (tester) async {
      await _pump(tester, AsyncData(_fullReview(nextWeek: null)));
      expect(find.text('下周计划尚未生成'), findsOneWidget);
    });
  });

  group('WeekReviewScreen — empty TSB series', () {
    testWidgets('shows 暂无 TSB 数据 placeholder when tsb_series is empty', (tester) async {
      final review = WeekReview(
        folder: _folder,
        dateFrom: '2026-05-04',
        dateTo: '2026-05-10',
        summary: _summary,
        tsbSeries: const [],
        sessions: const [],
        activityHighlights: const [],
        insights: const [],
        nextWeekPreview: null,
      );
      await _pump(tester, AsyncData(review));
      expect(find.text('暂无 TSB 数据'), findsOneWidget);
    });
  });

  group('WeekReviewScreen — loading / error states', () {
    testWidgets('shows loading indicator while fetching', (tester) async {
      await _pump(tester, const AsyncLoading());
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('shows error body on failure', (tester) async {
      await _pump(
        tester,
        AsyncError(Exception('network error'), StackTrace.empty),
      );
      expect(find.text('加载失败'), findsOneWidget);
      expect(find.text('重试'), findsOneWidget);
    });
  });
}
