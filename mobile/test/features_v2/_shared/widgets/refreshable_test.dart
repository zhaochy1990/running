import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/_shared/widgets/refreshable.dart';

final _testProvider = FutureProvider.autoDispose<int>((ref) async => 1);

Future<void> _pumpWith(WidgetTester tester, FutureOr<int> Function() factory) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        _testProvider.overrideWith((ref) async => factory()),
      ],
      child: MaterialApp(
        home: Scaffold(
          body: StrideRefreshable<int>(
            provider: _testProvider.future,
            child: Consumer(
              builder: (context, ref, _) {
                final v = ref.watch(_testProvider);
                return ListView(
                  children: [
                    SizedBox(
                      height: 800,
                      child: Center(child: Text('value=${v.valueOrNull ?? "-"}')),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('renders child unchanged on initial pump', (tester) async {
    var calls = 0;
    await _pumpWith(tester, () {
      calls++;
      return 1;
    });
    expect(find.text('value=1'), findsOneWidget);
    expect(calls, 1);
  });

  testWidgets('pull triggers provider re-fetch', (tester) async {
    var calls = 0;
    await _pumpWith(tester, () {
      calls++;
      return calls;
    });
    expect(find.text('value=1'), findsOneWidget);

    await tester.fling(find.byType(ListView), const Offset(0, 300), 1000);
    await tester.pumpAndSettle();

    expect(calls, greaterThanOrEqualTo(2));
    expect(find.text('value=2'), findsOneWidget);
  });

  testWidgets('errors from provider are swallowed (no rethrow)', (tester) async {
    await _pumpWith(tester, () => throw Exception('boom'));
    await tester.fling(find.byType(ListView), const Offset(0, 300), 1000);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
