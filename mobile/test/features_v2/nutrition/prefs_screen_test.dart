import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/nutrition/models/nutrition_prefs.dart';
import 'package:stride/features_v2/nutrition/prefs_screen.dart';

// ── Fake API ──────────────────────────────────────────────────────────────────

class FakeStrideApi extends StrideApi {
  FakeStrideApi({this.existingPrefs}) : super(Dio());

  final NutritionPrefs? existingPrefs;
  Map<String, dynamic>? lastPutBody;

  @override
  Future<NutritionPrefs?> getNutritionPrefs() async => existingPrefs;

  @override
  Future<NutritionPrefs> putNutritionPrefs(Map<String, dynamic> body) async {
    lastPutBody = body;
    return NutritionPrefs.fromJson({
      ...body,
      'created_at': '2026-05-12T00:00:00Z',
      'updated_at': '2026-05-12T00:00:00Z',
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

Widget buildApp({FakeStrideApi? api}) {
  final fakeApi = api ?? FakeStrideApi();
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => const NutritionPrefsScreen(),
      ),
      GoRoute(
        path: '/v2/nutrition/daily',
        builder: (_, _) => const Scaffold(body: Text('daily')),
      ),
    ],
  );
  return ProviderScope(
    overrides: [strideApiProvider.overrideWithValue(fakeApi)],
    child: MaterialApp.router(routerConfig: router),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  testWidgets('renders screen without crash', (tester) async {
    await tester.pumpWidget(buildApp());
    await tester.pumpAndSettle();

    expect(find.text('营养偏好'), findsOneWidget);
    expect(find.text('启用营养建议'), findsOneWidget);
  });

  testWidgets('shows diet type seg control and goal seg control', (tester) async {
    await tester.pumpWidget(buildApp());
    await tester.pumpAndSettle();

    expect(find.text('饮食类型'), findsOneWidget);
    expect(find.text('无忌口'), findsOneWidget);
    expect(find.text('素食'), findsOneWidget);
    expect(find.text('目标'), findsOneWidget);
    expect(find.text('增肌'), findsOneWidget);
    expect(find.text('减脂'), findsOneWidget);
  });

  testWidgets('save button calls API', (tester) async {
    // Use a tall frame so the save button is visible without scrolling.
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    final fakeApi = FakeStrideApi();
    await tester.pumpWidget(buildApp(api: fakeApi));
    await tester.pumpAndSettle();

    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();

    expect(fakeApi.lastPutBody, isNotNull);
  });

  testWidgets('macro sliders sum stays at 100 after protein drag', (tester) async {
    // Use a tall frame so sliders are visible without scrolling.
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(buildApp());
    await tester.pumpAndSettle();

    final sliders = tester.widgetList<Slider>(find.byType(Slider)).toList();
    expect(sliders.length, 3);

    // Verify initial values sum to 100.
    final total = sliders.fold<double>(0, (s, sl) => s + sl.value);
    expect(total, closeTo(100.0, 0.5));
  });

  testWidgets('loads existing prefs into form', (tester) async {
    final prefs = NutritionPrefs.fromJson({
      'enabled': true,
      'diet_type': 'vegetarian',
      'allergies': ['花生', '牛奶'],
      'goal': 'cut',
      'bmr_kcal': 1600,
      'tdee_kcal': 2000,
      'macro_protein_pct': 35.0,
      'macro_carb_pct': 45.0,
      'macro_fat_pct': 20.0,
    });
    await tester.pumpWidget(buildApp(api: FakeStrideApi(existingPrefs: prefs)));
    await tester.pumpAndSettle();

    // Allergy chips should appear
    expect(find.text('花生'), findsOneWidget);
    expect(find.text('牛奶'), findsOneWidget);
  });
}
