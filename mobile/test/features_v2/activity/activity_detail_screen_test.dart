import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/activity/activity_detail_screen.dart';
import 'package:stride/features_v2/activity/models/activity_detail.dart';
import 'package:stride/features_v2/activity/models/timeseries_data.dart';
import 'package:stride/features_v2/activity/providers/activity_detail_provider.dart';
import 'package:stride/features_v2/activity/providers/timeseries_provider.dart';

// ── Fixtures ──────────────────────────────────────────────────────────────

ActivityDetailV2 _makeDetail({
  String? commentary,
  String? sportNote,
  String? commentaryGeneratedBy,
}) {
  return ActivityDetailV2(
    activity: ActivityV2(
      labelId: 'ACT_001',
      sportName: 'running',
      date: '2026-05-11',
      distanceKm: 10.2,
      durationFmt: '54:05',
      paceFmt: "5'18\"/km",
      name: '晨跑 10K',
      avgHr: 152,
      caloriesKcal: 612,
      ascentM: 45,
      commentary: commentary,
      commentaryGeneratedBy: commentaryGeneratedBy,
      sportNote: sportNote,
    ),
    laps: const [
      LapV2(
        lapIndex: 0,
        distanceKm: 1.0,
        durationS: 320,
        durationFmt: '5:20',
        paceFmt: "5'20\"/km",
        avgHr: 148,
      ),
    ],
    zones: const [],
  );
}

// ── Stub StrideApi ───────────────────────────────────────────────────────
//
// The (id, fields: Set<String>) family key has identity equality on the
// `fields` Set, so a per-record `timeseriesProvider(...).overrideWith(...)`
// does NOT match the widget's own `{fieldStr}` Set literal at call time.
// Override `strideApiProvider` instead so the real Dio client never fires
// when scrollUntilVisible scrolls past a chart sliver.
class _StubApi extends StrideApi {
  _StubApi() : super(Dio());

  @override
  Future<TimeseriesData> getActivityTimeseries(
    String user,
    String labelId, {
    int downsample = 300,
    Set<String>? fields,
  }) {
    // Never resolves — matches the pre-wave-1 "verifies AC7 lazy load"
    // contract while keeping the FakeAsync timer queue empty.
    return Completer<TimeseriesData>().future;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/// Build a ProviderScope + MaterialApp with [activityDetailProvider] overridden.
Future<void> _pump(
  WidgetTester tester,
  AsyncValue<ActivityDetailV2> state, {
  String activityId = 'ACT_001',
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        activityDetailProvider(activityId).overrideWith(
          (_) => _resolve(state),
        ),
        strideApiProvider.overrideWithValue(_StubApi()),
        currentUserIdProvider.overrideWithValue('user-001'),
      ],
      child: MaterialApp(
        home: ActivityDetailScreen(activityId: activityId),
      ),
    ),
  );
  // Settle so FutureProvider resolves
  await tester.pumpAndSettle();
}

Future<ActivityDetailV2> _resolve(AsyncValue<ActivityDetailV2> state) {
  return switch (state) {
    AsyncData(:final value) => Future.value(value),
    AsyncError(:final error, :final stackTrace) =>
      Future.error(error, stackTrace),
    _ => Completer<ActivityDetailV2>().future, // stays loading
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

void main() {
  testWidgets('renders activity name in top bar', (tester) async {
    await _pump(tester, AsyncData(_makeDetail()));

    expect(find.text('晨跑 10K'), findsAtLeastNWidgets(1));
  });

  testWidgets('renders primary stats: distance / duration / pace', (tester) async {
    await _pump(tester, AsyncData(_makeDetail()));

    // '距离' appears in both lap-table header and stat row
    expect(find.text('距离'), findsAtLeastNWidgets(1));
    expect(find.text('时长'), findsAtLeastNWidgets(1));
    expect(find.text('配速'), findsAtLeastNWidgets(1));
    expect(find.textContaining('10.20'), findsOneWidget);
    expect(find.text('54:05'), findsOneWidget);
  });

  testWidgets('renders secondary stats: HR / calories / ascent', (tester) async {
    await _pump(tester, AsyncData(_makeDetail()));

    expect(find.text('心率'), findsOneWidget);
    expect(find.text('卡路里'), findsOneWidget);
    expect(find.text('累计爬升'), findsOneWidget);
    expect(find.text('152'), findsOneWidget);
  });

  testWidgets('commentary text is shown when present', (tester) async {
    await _pump(
      tester,
      AsyncData(_makeDetail(commentary: '节奏稳定，有氧效率良好。')),
    );

    expect(find.textContaining('节奏稳定'), findsOneWidget);
  });

  testWidgets('commentary absent shows 暂无 AI 点评', (tester) async {
    await _pump(tester, AsyncData(_makeDetail(commentary: null)));

    expect(find.text('暂无 AI 点评'), findsOneWidget);
  });

  testWidgets('sport_note is shown when present', (tester) async {
    await _pump(
      tester,
      AsyncData(_makeDetail(sportNote: '今天感觉很好，配速轻松。')),
    );

    // Training-note section sits below the charts; SliverChildListDelegate
    // is lazy, so the children must scroll into view to mount. The _StubApi
    // keeps the chart's timeseries future unresolved, so no real Dio fires.
    await tester.scrollUntilVisible(
      find.textContaining('今天感觉很好'),
      500,
    );
    expect(find.textContaining('今天感觉很好'), findsOneWidget);
  });

  testWidgets('sport_note=null shows v1.x placeholder', (tester) async {
    await _pump(tester, AsyncData(_makeDetail(sportNote: null)));

    await tester.scrollUntilVisible(
      find.textContaining('v1.x 即将支持'),
      500,
    );
    expect(find.textContaining('v1.x 即将支持'), findsOneWidget);
  });

  testWidgets('GPS map placeholder is shown', (tester) async {
    await _pump(tester, AsyncData(_makeDetail()));

    expect(find.text('GPS 轨迹'), findsOneWidget);
  });

  testWidgets('lap table renders lap rows', (tester) async {
    await _pump(tester, AsyncData(_makeDetail()));

    // Lap table sits below the charts; same offstage-clipping concern
    // as the sport_note tests.
    expect(find.text('圈', skipOffstage: false), findsOneWidget);
  });

  testWidgets('loading state shows CircularProgressIndicator', (tester) async {
    // Use pump (not pumpAndSettle) so loading spinner stays visible
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          activityDetailProvider('ACT_001').overrideWith(
            (_) => Completer<ActivityDetailV2>().future,
          ),
          timeseriesProvider((id: 'ACT_001', fields: {'hr'})).overrideWith(
            (_) => Completer<TimeseriesData>().future,
          ),
          timeseriesProvider((id: 'ACT_001', fields: {'pace'})).overrideWith(
            (_) => Completer<TimeseriesData>().future,
          ),
          currentUserIdProvider.overrideWithValue('user-001'),
        ],
        child: const MaterialApp(
          home: ActivityDetailScreen(activityId: 'ACT_001'),
        ),
      ),
    );
    await tester.pump(); // first frame only — loading state visible

    expect(find.byType(CircularProgressIndicator), findsAtLeastNWidgets(1));
  });

  testWidgets('error state shows 加载失败', (tester) async {
    await _pump(
      tester,
      AsyncError(Exception('network error'), StackTrace.empty),
    );

    // Hero title + body error column both render the string post-wave-1.
    expect(find.text('加载失败'), findsAtLeastNWidgets(1));
  });

  testWidgets('AI commentary card shows 重新生成 button', (tester) async {
    await _pump(
      tester,
      AsyncData(_makeDetail(commentary: '训练点评内容。')),
    );

    expect(find.text('重新生成'), findsOneWidget);
  });

  testWidgets('commentary_generated_by shown as pill', (tester) async {
    await _pump(
      tester,
      AsyncData(_makeDetail(
        commentary: '好的训练。',
        commentaryGeneratedBy: 'gpt-4.1',
      )),
    );

    expect(find.text('gpt-4.1'), findsOneWidget);
  });
}
