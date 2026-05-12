import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/_shared/widgets/stat_row.dart';

void main() {
  testWidgets('renders 3 items', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: StrideStatRow(items: const [
          StatItem(label: 'PACE', value: '5:00', unit: 'min/km'),
          StatItem(label: 'HR', value: '142', unit: 'bpm'),
          StatItem(label: 'DIST', value: '10.0', unit: 'km'),
        ]),
      ),
    ));
    expect(find.text('PACE'), findsOneWidget);
    expect(find.text('5:00'), findsOneWidget);
    expect(find.text('min/km'), findsOneWidget);
    expect(find.text('HR'), findsOneWidget);
    expect(find.text('DIST'), findsOneWidget);
  });

  testWidgets('asserts items.length == 3', (tester) async {
    expect(
      () => StrideStatRow(items: const [
        StatItem(label: 'A', value: '1'),
        StatItem(label: 'B', value: '2'),
      ]),
      throwsA(isA<AssertionError>()),
    );
  });

  testWidgets('unit can be null', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: StrideStatRow(items: const [
          StatItem(label: 'A', value: '1'),
          StatItem(label: 'B', value: '2'),
          StatItem(label: 'C', value: '3'),
        ]),
      ),
    ));
    expect(tester.takeException(), isNull);
  });
}
