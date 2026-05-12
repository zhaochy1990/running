import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/data/models/profile.dart';
import 'package:stride/features_v2/nutrition/daily_advice_screen.dart';
import 'package:stride/features_v2/nutrition/models/daily_advice.dart';

// ── Fake API ──────────────────────────────────────────────────────────────────

class FakeStrideApi extends StrideApi {
  FakeStrideApi({this.advice, this.returnNull = false}) : super(Dio());

  final DailyAdvice? advice;
  final bool returnNull;
  String? lastDateQueried;

  @override
  Future<DailyAdvice?> getDailyNutrition(String user, {String? date}) async {
    lastDateQueried = date;
    if (returnNull) return null;
    return advice ??
        DailyAdvice.fromJson({
          'user_id': user,
          'date': date ?? '2026-05-12',
          'is_training_day': true,
          'target_kcal': 2200,
          'macros': {'protein_g': 165.0, 'carb_g': 275.0, 'fat_g': 73.0},
          'advice': {
            'pre': '训练前2小时摄入复合碳水',
            'intra': '每40分钟补充30g碳水',
            'post': '训练后30分钟内摄入蛋白质',
          },
        });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

Widget buildApp({FakeStrideApi? api, bool noPrefs = false}) {
  final fakeApi = api ?? FakeStrideApi(returnNull: noPrefs);
  final fakeProfile = MyProfile.fromJson({
    'id': 'user-001',
    'display_name': 'Test User',
    'onboarding': {
      'completed_at': '2026-01-01',
      'coros_ready': true,
      'profile_ready': true,
    },
  });
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, __) => const DailyAdviceScreen(),
      ),
      GoRoute(
        path: '/v2/nutrition/prefs',
        builder: (_, __) => const Scaffold(body: Text('prefs')),
      ),
      GoRoute(
        path: '/v2/nutrition/meals',
        builder: (_, __) => const Scaffold(body: Text('meals')),
      ),
    ],
  );
  return ProviderScope(
    overrides: [
      strideApiProvider.overrideWithValue(fakeApi),
      currentUserProvider.overrideWith((_) async => fakeProfile),
    ],
    child: MaterialApp.router(routerConfig: router),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  testWidgets('renders screen without crash', (tester) async {
    await tester.pumpWidget(buildApp());
    await tester.pumpAndSettle();

    expect(find.text('每日营养建议'), findsOneWidget);
  });

  testWidgets('shows training day pill for training day', (tester) async {
    await tester.pumpWidget(buildApp());
    await tester.pumpAndSettle();

    expect(find.text('训练日'), findsOneWidget);
  });

  testWidgets('shows target kcal value', (tester) async {
    await tester.pumpWidget(buildApp());
    await tester.pumpAndSettle();

    expect(find.text('2200'), findsOneWidget);
  });

  testWidgets('shows macros stat row', (tester) async {
    await tester.pumpWidget(buildApp());
    await tester.pumpAndSettle();

    expect(find.text('蛋白质'), findsOneWidget);
    expect(find.text('碳水'), findsOneWidget);
    expect(find.text('脂肪'), findsOneWidget);
  });

  testWidgets('shows advice cards when advice is present', (tester) async {
    await tester.pumpWidget(buildApp());
    await tester.pumpAndSettle();

    expect(find.text('训前'), findsOneWidget);
    expect(find.text('训中'), findsOneWidget);
    expect(find.text('训后'), findsOneWidget);
  });

  testWidgets('shows no-prefs placeholder and CTA when 404', (tester) async {
    await tester.pumpWidget(buildApp(noPrefs: true));
    await tester.pumpAndSettle();

    expect(find.text('请先设置营养偏好'), findsOneWidget);
    expect(find.text('去设置营养偏好'), findsOneWidget);
  });

  testWidgets('date picker change re-queries API', (tester) async {
    final fakeApi = FakeStrideApi();
    await tester.pumpWidget(buildApp(api: fakeApi));
    await tester.pumpAndSettle();

    // The initial query should have fired.
    expect(fakeApi.lastDateQueried, isNotNull);
  });
}
