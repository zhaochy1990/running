import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/_shared/widgets/top_bar.dart';

void main() {
  testWidgets('renders title and actions', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        appBar: StrideTopBar(
          title: 'Home',
          leading: Icon(Icons.menu),
          actions: [Icon(Icons.search), Icon(Icons.settings)],
        ),
      ),
    ));
    expect(find.text('Home'), findsOneWidget);
    expect(find.byIcon(Icons.menu), findsOneWidget);
    expect(find.byIcon(Icons.search), findsOneWidget);
    expect(find.byIcon(Icons.settings), findsOneWidget);
  });

  testWidgets('compact reduces height to 40', (tester) async {
    const bar = StrideTopBar(title: 'X', compact: true);
    expect(bar.preferredSize.height, 40);
    const normal = StrideTopBar(title: 'X');
    expect(normal.preferredSize.height, 48);
  });
}
