import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/_shared/widgets/stat_row.dart';

void main() {
  testWidgets('renders 3 items', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: StrideStatRow(items: [
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

  testWidgets('renders N items (no fixed column count)', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: StrideStatRow(items: [
          StatItem(label: 'A', value: '1'),
          StatItem(label: 'B', value: '2'),
        ]),
      ),
    ));
    expect(find.text('A'), findsOneWidget);
    expect(find.text('B'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('unit can be null', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: StrideStatRow(items: [
          StatItem(label: 'A', value: '1'),
          StatItem(label: 'B', value: '2'),
          StatItem(label: 'C', value: '3'),
        ]),
      ),
    ));
    expect(tester.takeException(), isNull);
  });
}
