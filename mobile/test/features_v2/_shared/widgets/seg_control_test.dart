import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/_shared/widgets/seg_control.dart';

void main() {
  testWidgets('renders options and calls onChanged', (tester) async {
    int selected = 0;
    await tester.pumpWidget(StatefulBuilder(
      builder: (ctx, setState) => MaterialApp(
        home: Scaffold(
          body: StrideSegControl(
            options: const ['Day', 'Week', 'Month'],
            selectedIndex: selected,
            onChanged: (i) => setState(() => selected = i),
          ),
        ),
      ),
    ));
    expect(find.text('Day'), findsOneWidget);
    expect(find.text('Week'), findsOneWidget);
    expect(find.text('Month'), findsOneWidget);

    await tester.tap(find.text('Week'));
    await tester.pump();
    expect(selected, 1);
  });
}
