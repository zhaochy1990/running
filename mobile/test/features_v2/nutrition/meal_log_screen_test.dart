import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/data/models/profile.dart';
import 'package:stride/features_v2/nutrition/meal_log_screen.dart';
import 'package:stride/features_v2/nutrition/models/meals_daily.dart';

// ── Fake API ──────────────────────────────────────────────────────────────────

class FakeStrideApi extends StrideApi {
  FakeStrideApi({this.meals}) : super(Dio());

  final MealsDaily? meals;
  Map<String, dynamic>? lastPostBody;

  @override
  Future<MealsDaily?> getDailyMeals(String user, {String? date}) async {
    return meals ??
        MealsDaily.fromJson({
          'date': date ?? '2026-05-12',
          'meals': <dynamic>[],
          'daily_totals': {
            'kcal': 0.0,
            'protein_g': 0.0,
            'carb_g': 0.0,
            'fat_g': 0.0,
          },
        });
  }

  @override
  Future<Map<String, dynamic>> postMeal(
    String user,
    Map<String, dynamic> body,
  ) async {
    lastPostBody = body;
    return {
      'meal_id': 'meal-001',
      'date': body['date'],
      'meal_type': body['meal_type'],
      'created_at': '2026-05-12T12:00:00Z',
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

Widget buildApp({FakeStrideApi? api}) {
  final fakeApi = api ?? FakeStrideApi();
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
        builder: (_, _) => const MealLogScreen(),
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

    expect(find.text('营养记录'), findsOneWidget);
  });

  testWidgets('renders 4 meal type cards', (tester) async {
    await tester.pumpWidget(buildApp());
    await tester.pumpAndSettle();

    expect(find.text('早餐'), findsWidgets);
    expect(find.text('午餐'), findsOneWidget);
    expect(find.text('晚餐'), findsOneWidget);
    expect(find.text('加餐'), findsWidgets);
  });

  testWidgets('shows daily totals section', (tester) async {
    await tester.pumpWidget(buildApp());
    await tester.pumpAndSettle();

    expect(find.text('日合计'), findsOneWidget);
    expect(find.text('总热量'), findsOneWidget);
  });

  testWidgets('FAB tap opens add meal bottom sheet', (tester) async {
    await tester.pumpWidget(buildApp());
    await tester.pumpAndSettle();

    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();

    expect(find.text('添加餐食'), findsOneWidget);
    expect(find.text('餐次'), findsOneWidget);
    expect(find.text('食物条目'), findsOneWidget);
    expect(find.text('提交'), findsOneWidget);
  });

  testWidgets('bottom sheet seg control shows all meal types', (tester) async {
    await tester.pumpWidget(buildApp());
    await tester.pumpAndSettle();

    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();

    // SegControl inside sheet shows 早餐/午餐/晚餐/加餐
    expect(find.text('早餐'), findsWidgets);
    expect(find.text('午餐'), findsWidgets);
  });

  testWidgets('submit calls postMeal API', (tester) async {
    final fakeApi = FakeStrideApi();
    await tester.pumpWidget(buildApp(api: fakeApi));
    await tester.pumpAndSettle();

    // Open sheet
    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();

    // Enter item name in first text field (the name field)
    final nameFields = find.byType(TextField);
    await tester.enterText(nameFields.first, '米饭');
    await tester.pumpAndSettle();

    // Tap submit
    await tester.tap(find.text('提交'));
    await tester.pumpAndSettle();

    expect(fakeApi.lastPostBody, isNotNull);
    expect(fakeApi.lastPostBody!['meal_type'], isNotNull);
  });

  testWidgets('renders meal items when data present', (tester) async {
    final mealsData = MealsDaily.fromJson({
      'date': '2026-05-12',
      'meals': [
        {
          'meal_id': 'm1',
          'meal_type': 'breakfast',
          'items': [
            {
              'name': '燕麦粥',
              'kcal': 350.0,
              'protein_g': 12.0,
              'carb_g': 60.0,
              'fat_g': 5.0,
            }
          ],
        }
      ],
      'daily_totals': {
        'kcal': 350.0,
        'protein_g': 12.0,
        'carb_g': 60.0,
        'fat_g': 5.0,
      },
    });

    await tester.pumpWidget(buildApp(api: FakeStrideApi(meals: mealsData)));
    await tester.pumpAndSettle();

    expect(find.text('燕麦粥'), findsOneWidget);
    expect(find.text('350 kcal'), findsWidgets);
  });
}
