import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/health/models/pb_record.dart';
import 'package:stride/features_v2/health/pb_records_screen.dart';
import 'package:stride/features_v2/health/providers/pb_records_provider.dart';

Future<void> _pump(
  WidgetTester tester,
  AsyncValue<PbsResponse> state,
) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        pbRecordsProvider.overrideWith((_) => _resolve(state)),
      ],
      child: const MaterialApp(home: PbRecordsScreen()),
    ),
  );
  await tester.pump();
}

Future<PbsResponse> _resolve(AsyncValue<PbsResponse> state) {
  return switch (state) {
    AsyncData(:final value) => Future.value(value),
    AsyncError(:final error, :final stackTrace) =>
      Future.error(error, stackTrace),
    _ => Completer<PbsResponse>().future,
  };
}

const _fullResponse = PbsResponse(
  pbs: [
    PbRecord(
      distance: '5K',
      pbTimeSec: 1290,
      achievedAt: '2025-08-15',
      labelId: 'ACT_5k_001',
      history: [
        PbHistoryPoint(date: '2025-01-01', bestSoFarSec: 1500),
        PbHistoryPoint(date: '2025-04-01', bestSoFarSec: 1380),
        PbHistoryPoint(date: '2025-08-15', bestSoFarSec: 1290),
      ],
    ),
    PbRecord(
      distance: '10K',
      pbTimeSec: 2700,
      achievedAt: '2025-09-10',
      labelId: 'ACT_10k_001',
    ),
    PbRecord(
      distance: 'HM',
      pbTimeSec: 5940,
      achievedAt: '2025-10-20',
    ),
    PbRecord(
      distance: 'FM',
      pbTimeSec: 13200,
      achievedAt: '2025-11-03',
    ),
  ],
);

const _partialResponse = PbsResponse(
  pbs: [
    PbRecord(
      distance: '5K',
      pbTimeSec: 1290,
      achievedAt: '2025-08-15',
    ),
    // 10K, HM, FM deliberately absent
  ],
);

void main() {
  testWidgets('top bar title is 个人最佳', (tester) async {
    await _pump(tester, const AsyncData(_fullResponse));

    expect(find.text('个人最佳'), findsOneWidget);
  });

  testWidgets('renders 4 distance cards from full data', (tester) async {
    await _pump(tester, const AsyncData(_fullResponse));

    // All 4 distance labels present (scrolling if needed)
    for (final label in ['5 公里', '10 公里', '半马', '全马']) {
      await tester.scrollUntilVisible(
        find.text(label),
        300.0,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text(label), findsOneWidget);
    }
  });

  testWidgets('missing distance shows 尚无记录 placeholder', (tester) async {
    await _pump(tester, const AsyncData(_partialResponse));

    // 10K, HM, FM have no record — scroll until first placeholder is visible
    await tester.scrollUntilVisible(
      find.text('尚无记录').first,
      300.0,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('尚无记录'), findsAtLeast(1));
  });

  testWidgets('5K PB time 21:30 is displayed', (tester) async {
    await _pump(tester, const AsyncData(_fullResponse));

    // 1290s = 21m 30s
    expect(find.text('21:30'), findsOneWidget);
  });

  testWidgets('empty pbs response shows 4 placeholder cards', (tester) async {
    await _pump(tester, const AsyncData(PbsResponse.empty));

    // All 4 distance labels still shown
    for (final label in ['5 公里', '10 公里', '半马', '全马']) {
      await tester.scrollUntilVisible(
        find.text(label),
        300.0,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text(label), findsOneWidget);
    }
    // All show placeholder
    expect(find.text('尚无记录'), findsNWidgets(4));
  });

  testWidgets('loading state shows CircularProgressIndicator', (tester) async {
    final completer = Completer<PbsResponse>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          pbRecordsProvider.overrideWith((_) => completer.future),
        ],
        child: const MaterialApp(home: PbRecordsScreen()),
      ),
    );
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    completer.completeError(Exception('done'));
    await tester.pump();
  });

  testWidgets('error state shows 加载失败', (tester) async {
    await _pump(
      tester,
      AsyncError(Exception('network error'), StackTrace.empty),
    );
    await tester.pump();

    expect(find.text('加载失败'), findsOneWidget);
  });
}
