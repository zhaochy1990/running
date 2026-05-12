import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/theme/tokens.dart';
import 'package:stride/features_v2/_shared/widgets/nav_tab.dart';

void main() {
  testWidgets('renders icon + label and handles tap', (tester) async {
    var tapped = false;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: StrideNavTab(
          icon: Icons.home,
          label: 'Home',
          selected: true,
          onTap: () => tapped = true,
        ),
      ),
    ));
    expect(find.text('Home'), findsOneWidget);
    expect(find.byIcon(Icons.home), findsOneWidget);

    await tester.tap(find.byType(StrideNavTab));
    expect(tapped, true);
  });

  testWidgets('selected uses accent color', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: StrideNavTab(
          icon: Icons.home,
          label: 'Home',
          selected: true,
          onTap: () {},
        ),
      ),
    ));
    final icon = tester.widget<Icon>(find.byIcon(Icons.home));
    expect(icon.color, StrideTokens.accent);
  });
}
