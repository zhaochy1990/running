import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/core/router/routes_v2.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/onboarding/sync_progress_screen.dart';

class _FakeApi extends StrideApi {
  _FakeApi({required this.statuses}) : super(Dio());

  /// Sequence of `/sync-status` payloads returned in order. Last entry
  /// is replayed on subsequent polls.
  final List<Map<String, dynamic>> statuses;
  int _idx = 0;
  int startCalls = 0;

  @override
  Future<Map<String, dynamic>> startOnboardingSync() async {
    startCalls++;
    return const {'state': 'running'};
  }

  @override
  Future<Map<String, dynamic>> getOnboardingSyncStatus() async {
    final cur = statuses[_idx];
    if (_idx < statuses.length - 1) _idx++;
    return cur;
  }
}

Future<void> _pump(WidgetTester tester, _FakeApi api) async {
  final router = GoRouter(
    initialLocation: RoutesV2.onboardingSync,
    routes: [
      GoRoute(
        path: RoutesV2.onboardingSync,
        builder: (_, _) => const SyncProgressScreen(),
      ),
      GoRoute(
        path: RoutesV2.onboardingBasicInfo,
        builder: (_, _) => const Scaffold(body: Text('basic-info-screen')),
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
  testWidgets('done state routes to basic-info', (tester) async {
    final api = _FakeApi(statuses: [
      {
        'state': 'done',
        'progress': {'phase': 'health', 'percent': 100,
            'synced_activities': 3, 'synced_health': 7},
      },
    ]);
    await _pump(tester, api);
    // Let start() resolve + first poll fire.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.text('basic-info-screen'), findsOneWidget);
  });

  testWidgets('error state shows retry button', (tester) async {
    final api = _FakeApi(statuses: [
      {
        'state': 'error',
        'progress': {'phase': 'login'},
        'error': '同步失败',
      },
    ]);
    await _pump(tester, api);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(seconds: 3));
    expect(find.widgetWithText(FilledButton, '重试'), findsOneWidget);
  });

  testWidgets('renders running caption', (tester) async {
    final api = _FakeApi(statuses: [
      {
        'state': 'running',
        'progress': {
          'phase': 'activities',
          'percent': 40,
          'synced_activities': 5,
        },
      },
    ]);
    await _pump(tester, api);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(seconds: 3));
    expect(find.textContaining('活动'), findsWidgets);
    expect(find.text('40%'), findsOneWidget);
  });

  testWidgets('PopScope blocks back', (tester) async {
    final api = _FakeApi(statuses: [
      {'state': 'running', 'progress': {'phase': 'login'}},
    ]);
    await _pump(tester, api);
    await tester.pump();
    final popScope = tester.widget<PopScope>(find.byType(PopScope));
    expect(popScope.canPop, isFalse);
  });
}
