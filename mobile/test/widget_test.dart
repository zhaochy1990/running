import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/app.dart';

void main() {
  testWidgets('StrideApp launches and shows STRIDE wordmark', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: StrideApp()));
    await tester.pumpAndSettle();

    expect(find.text('STRIDE'), findsOneWidget);
  });
}
