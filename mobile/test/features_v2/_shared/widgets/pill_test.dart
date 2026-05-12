import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/theme/pill_colors.dart';
import 'package:stride/features_v2/_shared/widgets/pill.dart';

Future<void> _pump(WidgetTester tester, Widget child) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: Center(child: child))));
}

void main() {
  testWidgets('renders text', (tester) async {
    await _pump(tester, const StridePill(text: 'GOOD'));
    expect(find.text('GOOD'), findsOneWidget);
  });

  testWidgets('variant changes foreground color', (tester) async {
    await _pump(tester, const StridePill(text: 'X', variant: PillVariant.green));
    final greenText = tester.widget<Text>(find.text('X'));
    expect(greenText.style!.color, PillColors.of(PillVariant.green).fg);

    await _pump(tester, const StridePill(text: 'X', variant: PillVariant.danger));
    final dangerText = tester.widget<Text>(find.text('X'));
    expect(dangerText.style!.color, PillColors.of(PillVariant.danger).fg);
  });

  testWidgets('dense renders without errors', (tester) async {
    await _pump(tester, const StridePill(text: 'A', dense: true));
    expect(find.text('A'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
