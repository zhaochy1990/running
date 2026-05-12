import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/core/api/api_exception.dart';
import 'package:stride/core/router/routes_v2.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/onboarding/coros_link_screen.dart';

class _FakeApi extends StrideApi {
  _FakeApi({this.linkResult, this.linkError}) : super(Dio());

  final Map<String, dynamic>? linkResult;
  final Object? linkError;
  Map<String, dynamic>? lastCall;

  @override
  Future<Map<String, dynamic>> linkCoros({
    required String email,
    required String password,
    String? region,
  }) async {
    lastCall = {'email': email, 'password': password, 'region': region};
    if (linkError != null) throw linkError!;
    return linkResult ?? const {};
  }
}

Future<void> _pump(WidgetTester tester, _FakeApi api) async {
  final router = GoRouter(
    initialLocation: RoutesV2.onboardingCoros,
    routes: [
      GoRoute(
        path: RoutesV2.onboardingCoros,
        builder: (_, _) => const CorosLinkScreen(),
      ),
      GoRoute(
        path: RoutesV2.onboardingSync,
        builder: (_, _) => const Scaffold(body: Text('sync-screen')),
      ),
      GoRoute(
        path: RoutesV2.onboardingBrand,
        builder: (_, _) => const Scaffold(body: Text('brand-screen')),
      ),
    ],
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [strideApiProvider.overrideWithValue(api)],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
}

void main() {
  testWidgets('submit disabled until email + password filled', (tester) async {
    final api = _FakeApi(linkResult: const {});
    await _pump(tester, api);
    final btn = find.widgetWithText(FilledButton, '绑定');
    expect(btn, findsOneWidget);
    expect(tester.widget<FilledButton>(btn).onPressed, isNull);

    await tester.enterText(find.byType(TextField).first, 'a@b.com');
    await tester.pump();
    expect(tester.widget<FilledButton>(btn).onPressed, isNull);

    await tester.enterText(find.byType(TextField).at(1), 'pw');
    await tester.pump();
    expect(tester.widget<FilledButton>(btn).onPressed, isNotNull);
  });

  testWidgets('401 surfaces credential error', (tester) async {
    final api = _FakeApi(linkError: const ApiException(401, 'unauthorized'));
    await _pump(tester, api);

    await tester.enterText(find.byType(TextField).first, 'a@b.com');
    await tester.enterText(find.byType(TextField).at(1), 'pw');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '绑定'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.textContaining('邮箱或密码'), findsOneWidget);
  });

  testWidgets('region keyword maps to switch-region hint', (tester) async {
    final api = _FakeApi(
      linkError: const ApiException(400, 'wrong region detected'),
    );
    await _pump(tester, api);
    await tester.enterText(find.byType(TextField).first, 'a@b.com');
    await tester.enterText(find.byType(TextField).at(1), 'pw');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '绑定'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.textContaining('切换区域'), findsOneWidget);
  });

  testWidgets('region picker has both options visible', (tester) async {
    final api = _FakeApi();
    await _pump(tester, api);
    expect(find.text('中国'), findsOneWidget);
    expect(find.text('全球'), findsOneWidget);
  });
}
