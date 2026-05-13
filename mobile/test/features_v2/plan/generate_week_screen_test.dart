/// Widget tests for D1 GenerateWeekScreen (T27).
///
/// Tests use provider overrides to inject a fixed [GenerateWeekState] without
/// making any real HTTP calls.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/features_v2/plan/generate_week_screen.dart';
import 'package:stride/features_v2/plan/providers/generate_week_provider.dart';

const _weekStart = '2026-05-11';
const _folder = '2026-05-11_05-17(W2)';

// ── Fake notifier ─────────────────────────────────────────────────────────────

/// A [GenerateWeekNotifier] that starts with a fixed state and whose
/// [generate] method is a no-op. Uses the protected `withState` constructor
/// so no real [StrideApi] or userId is needed.
class _FixedNotifier extends GenerateWeekNotifier {
  _FixedNotifier(super.state)
      : super.withState();

  @override
  Future<void> generate(String weekStart, {bool force = false}) async {
    // no-op — state is pre-set by the test
  }
}

// ── Router + pump helpers ─────────────────────────────────────────────────────

/// Records paths that the screen navigates to via [GoRouter.pushReplacement].
final List<String> _navigated = [];

GoRouter _buildRouter(GenerateWeekState initialState) {
  _navigated.clear();
  return GoRouter(
    initialLocation: '/generate',
    routes: [
      GoRoute(
        path: '/generate',
        builder: (_, _) => ProviderScope(
          overrides: [
            generateWeekProvider.overrideWith(
              (_) => _FixedNotifier(initialState),
            ),
          ],
          child: const GenerateWeekScreen(weekStart: _weekStart),
        ),
      ),
      // Stub target for D2 week detail navigation.
      GoRoute(
        path: '/v2/plan/weeks/:folder',
        builder: (_, state) {
          _navigated.add('/v2/plan/weeks/${state.pathParameters['folder']}');
          return const Scaffold(body: Text('WeekDetail stub'));
        },
      ),
    ],
  );
}

Future<void> _pump(WidgetTester tester, GenerateWeekState state) async {
  await tester.pumpWidget(
    ProviderScope(
      child: MaterialApp.router(routerConfig: _buildRouter(state)),
    ),
  );
  await tester.pump();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  group('GenerateWeekScreen — generating', () {
    testWidgets('shows circular progress indicator while generating',
        (tester) async {
      await _pump(tester, const GenerateWeekGenerating());
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('shows 正在生成下周计划 headline text', (tester) async {
      await _pump(tester, const GenerateWeekGenerating());
      expect(find.text('正在生成下周计划...'), findsOneWidget);
    });
  });

  group('GenerateWeekScreen — success', () {
    testWidgets('navigates to week detail on success', (tester) async {
      await _pump(tester, const GenerateWeekSuccess(folder: _folder));
      // Allow the addPostFrameCallback + pushReplacement to fire.
      // Use pump(Duration.zero) rather than pumpAndSettle to avoid timing out
      // on the periodic phase animation timer.
      await tester.pump(Duration.zero);
      await tester.pump(Duration.zero);

      expect(_navigated, contains('/v2/plan/weeks/$_folder'));
    });
  });

  group('GenerateWeekScreen — conflict (409)', () {
    testWidgets('shows conflict dialog on 409', (tester) async {
      await _pump(tester, const GenerateWeekConflict());
      // Allow addPostFrameCallback to fire and showDialog to complete.
      await tester.pump(Duration.zero);
      await tester.pump(Duration.zero);

      expect(find.text('下周计划已存在，覆盖生成？'), findsOneWidget);
      expect(find.text('覆盖生成'), findsOneWidget);
      expect(find.text('取消'), findsOneWidget);
    });
  });

  group('GenerateWeekScreen — error', () {
    testWidgets('shows error message and retry button on generic error',
        (tester) async {
      await _pump(tester, const GenerateWeekError(message: '网络连接失败'));
      await tester.pump();

      expect(find.text('生成失败'), findsOneWidget);
      expect(find.text('网络连接失败'), findsOneWidget);
      expect(find.text('重试'), findsOneWidget);
    });

    testWidgets('retry button is tappable without throwing', (tester) async {
      await _pump(tester, const GenerateWeekError(message: 'server error'));
      await tester.pump();

      await tester.tap(find.text('重试'));
      await tester.pump();
      // No exception → pass
    });
  });
}
