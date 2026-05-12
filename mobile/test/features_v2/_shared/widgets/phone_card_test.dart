import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/_shared/widgets/phone_card.dart';

void main() {
  testWidgets('renders child', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: Center(
          child: StridePhoneCard(child: Text('inside')),
        ),
      ),
    ));
    expect(find.text('inside'), findsOneWidget);
  });
}
