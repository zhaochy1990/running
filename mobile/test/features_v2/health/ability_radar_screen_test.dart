import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/health/ability_radar_screen.dart';
import 'package:stride/features_v2/health/models/ability_snapshot.dart';
import 'package:stride/features_v2/health/providers/ability_snapshot_provider.dart';

Future<void> _pump(
  WidgetTester tester,
  AsyncValue<AbilitySnapshot> state,
) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        abilitySnapshotProvider.overrideWith((_) => _resolve(state)),
      ],
      child: const MaterialApp(home: AbilityRadarScreen()),
    ),
  );
  await tester.pump();
}

Future<AbilitySnapshot> _resolve(AsyncValue<AbilitySnapshot> state) {
  return switch (state) {
    AsyncData(:final value) => Future.value(value),
    AsyncError(:final error, :final stackTrace) =>
      Future.error(error, stackTrace),
    _ => Completer<AbilitySnapshot>().future,
  };
}

const _fullSnapshot = AbilitySnapshot(
  date: '20260512',
  source: 'coros',
  l3Dimensions: {
    'endurance': 72.0,
    'speed': 55.0,
    'threshold': 68.0,
    'vo2max': 63.0,
    'economy': 58.0,
    'freshness': 45.0,
  },
  l4Composite: 60.2,
);

void main() {
  testWidgets('top bar title is 能力分析', (tester) async {
    await _pump(tester, const AsyncData(_fullSnapshot));

    expect(find.text('能力分析'), findsOneWidget);
  });

  testWidgets('renders 6 dimension cards', (tester) async {
    await _pump(tester, const AsyncData(_fullSnapshot));

    // Scroll through all dimension cards
    for (final meta in DimensionMeta.all) {
      await tester.scrollUntilVisible(
        find.text(meta.label),
        300.0,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text(meta.label), findsAtLeast(1));
    }
  });

  testWidgets('dimension card count is exactly 6', (tester) async {
    await _pump(tester, const AsyncData(_fullSnapshot));

    expect(DimensionMeta.all.length, 6);
    final labels = DimensionMeta.all.map((m) => m.label).toSet();
    expect(labels, {
      '耐力',
      '速度',
      '阈值',
      'VO₂max',
      '经济性',
      '新鲜度',
    });
  });

  testWidgets('overall score badge shows l4Composite', (tester) async {
    await _pump(tester, const AsyncData(_fullSnapshot));

    expect(find.text('60'), findsOneWidget); // toStringAsFixed(0)
  });

  testWidgets('strong band shows green pill', (tester) async {
    const snapshot = AbilitySnapshot(
      date: '20260512',
      source: 'coros',
      l3Dimensions: {'endurance': 85.0},
    );
    await _pump(tester, const AsyncData(snapshot));

    await tester.scrollUntilVisible(
      find.text('强'),
      300.0,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('强'), findsAtLeast(1));
  });

  testWidgets('weak band shows 待提升 pill', (tester) async {
    const snapshot = AbilitySnapshot(
      date: '20260512',
      source: 'coros',
      l3Dimensions: {'endurance': 20.0},
    );
    await _pump(tester, const AsyncData(snapshot));

    await tester.scrollUntilVisible(
      find.text('待提升').first,
      300.0,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('待提升'), findsAtLeast(1));
  });

  testWidgets('loading state shows CircularProgressIndicator', (tester) async {
    final completer = Completer<AbilitySnapshot>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          abilitySnapshotProvider.overrideWith((_) => completer.future),
        ],
        child: const MaterialApp(home: AbilityRadarScreen()),
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
