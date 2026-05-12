/// Widget tests for D2b PushResultSheet.
///
/// Coverage:
///   1. 全成功 → 失败列表为空，显示成功摘要
///   2. 部分失败 → 重试按钮存在，点击调 API
///   3. 加载中 → 显示 "推送中..."
///   4. 成功列表可折叠
///   5. "完成" 按钮关闭 sheet
library;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/data/models/plan.dart';
import 'package:stride/features_v2/plan/providers/push_week_provider.dart';
import 'package:stride/features_v2/plan/widgets/push_result_sheet.dart';

// ── Mock StrideApi ─────────────────────────────────────────────────────────────

class _MockStrideApi extends StrideApi {
  _MockStrideApi() : super(Dio());

  final List<({String userId, String date, int sessionIndex})> pushCalls = [];

  @override
  Future<Map<String, dynamic>> pushPlannedSession(
    String user,
    String date,
    int sessionIndex,
  ) async {
    pushCalls.add((userId: user, date: date, sessionIndex: sessionIndex));
    return {'status': 'ok'};
  }

  @override
  Future<PlanDaysResponse> getPlanDays(
    String user,
    String from,
    String to,
  ) async {
    return const PlanDaysResponse(days: []);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

PushWeekResult _makeAllSuccess() {
  return const PushWeekResult(
    results: [
      SessionPushResult(
        date: '2026-05-12',
        sessionIndex: 0,
        sessionName: '晨间轻松跑',
        success: true,
      ),
      SessionPushResult(
        date: '2026-05-13',
        sessionIndex: 0,
        sessionName: '节奏跑',
        success: true,
      ),
    ],
  );
}

PushWeekResult _makePartialFailure() {
  return const PushWeekResult(
    results: [
      SessionPushResult(
        date: '2026-05-12',
        sessionIndex: 0,
        sessionName: '晨间轻松跑',
        success: true,
      ),
      SessionPushResult(
        date: '2026-05-13',
        sessionIndex: 0,
        sessionName: '节奏跑',
        success: false,
        errorMessage: 'watch offline',
      ),
    ],
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Pump sheet with a given [PushWeekState] injected via override.
///
/// Pass [settle] = false for loading states that contain perpetual animations
/// (e.g. CircularProgressIndicator) to avoid pumpAndSettle timeout.
Future<void> _pumpWithState(
  WidgetTester tester,
  PushWeekState seedState, {
  _MockStrideApi? mockApi,
  bool settle = true,
}) async {
  final api = mockApi ?? _MockStrideApi();

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        pushWeekProvider.overrideWith((ref) => _SeededNotifier(ref, seedState)),
        currentUserIdProvider.overrideWithValue('user-001'),
        strideApiProvider.overrideWithValue(api),
      ],
      child: MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Column(
              children: [
                ElevatedButton(
                  onPressed: () => showPushResultSheet(context),
                  child: const Text('open'),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );

  await tester.tap(find.text('open'));
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    // Just advance enough frames for the sheet to appear without settling
    // the perpetual spinner animation.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }
}

/// A [PushWeekNotifier] that starts with a pre-seeded state.
class _SeededNotifier extends PushWeekNotifier {
  _SeededNotifier(super.ref, PushWeekState seed) {
    // Override the state immediately after super constructor.
    state = seed;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  // ── 1. 全成功 ──────────────────────────────────────────────────────────────

  testWidgets('all success → failure list is empty, shows success count',
      (tester) async {
    await _pumpWithState(tester, PushWeekDone(_makeAllSuccess()));

    // Summary row shows success count
    expect(find.text('2'), findsAtLeastNWidgets(1)); // successCount
    expect(find.text('0'), findsAtLeastNWidgets(1)); // failureCount

    // No retry buttons
    expect(find.text('重试'), findsNothing);
  });

  testWidgets('all success → no failure section header', (tester) async {
    await _pumpWithState(tester, PushWeekDone(_makeAllSuccess()));

    // Failure section header "失败 X 项" should not appear
    expect(find.textContaining('失败 0 项'), findsNothing);
  });

  // ── 2. 部分失败 ────────────────────────────────────────────────────────────

  testWidgets('partial failure → retry button exists', (tester) async {
    await _pumpWithState(tester, PushWeekDone(_makePartialFailure()));
    expect(find.text('重试'), findsOneWidget);
  });

  testWidgets('partial failure → failure section header shown', (tester) async {
    await _pumpWithState(tester, PushWeekDone(_makePartialFailure()));
    expect(find.textContaining('失败 1 项'), findsOneWidget);
  });

  testWidgets('partial failure → tapping retry calls pushPlannedSession',
      (tester) async {
    final mockApi = _MockStrideApi();
    await _pumpWithState(
      tester,
      PushWeekDone(_makePartialFailure()),
      mockApi: mockApi,
    );

    await tester.tap(find.text('重试'));
    await tester.pumpAndSettle();

    expect(mockApi.pushCalls, hasLength(1));
    expect(mockApi.pushCalls.first.date, equals('2026-05-13'));
    expect(mockApi.pushCalls.first.sessionIndex, equals(0));
  });

  testWidgets('partial failure → failure item shows error message',
      (tester) async {
    await _pumpWithState(tester, PushWeekDone(_makePartialFailure()));
    expect(find.textContaining('watch offline'), findsOneWidget);
  });

  // ── 3. Loading state ────────────────────────────────────────────────────────
  // Use settle:false — CircularProgressIndicator animates forever and would
  // cause pumpAndSettle to time out.

  testWidgets('loading state shows 推送中... text', (tester) async {
    await _pumpWithState(tester, const PushWeekLoading(), settle: false);
    expect(find.text('推送中...'), findsOneWidget);
  });

  testWidgets('loading state shows CircularProgressIndicator', (tester) async {
    await _pumpWithState(tester, const PushWeekLoading(), settle: false);
    expect(find.byType(CircularProgressIndicator), findsAtLeastNWidgets(1));
  });

  // ── 4. 成功列表折叠 ────────────────────────────────────────────────────────

  testWidgets('success list is collapsed by default', (tester) async {
    await _pumpWithState(tester, PushWeekDone(_makeAllSuccess()));

    // Success items (session names) should not be visible by default
    expect(find.text('晨间轻松跑'), findsNothing);
    expect(find.text('节奏跑'), findsNothing);
  });

  testWidgets('tapping success header expands the list', (tester) async {
    await _pumpWithState(tester, PushWeekDone(_makeAllSuccess()));

    // Tap the collapsible success header
    await tester.tap(find.textContaining('成功 2 项'));
    await tester.pumpAndSettle();

    expect(find.text('晨间轻松跑'), findsOneWidget);
  });

  // ── 5. 完成 按钮 ───────────────────────────────────────────────────────────

  testWidgets('tapping 完成 closes the sheet', (tester) async {
    await _pumpWithState(tester, PushWeekDone(_makeAllSuccess()));

    await tester.tap(find.text('完成'));
    await tester.pumpAndSettle();

    // Sheet dismissed — PushResultSheet is no longer in the tree
    expect(find.byType(PushResultSheet), findsNothing);
  });

  // ── 6. Sheet title ─────────────────────────────────────────────────────────

  testWidgets('sheet shows 推送结果 title', (tester) async {
    await _pumpWithState(tester, PushWeekDone(_makeAllSuccess()));
    expect(find.text('推送结果'), findsOneWidget);
  });

  // ── 7. Summary counts ──────────────────────────────────────────────────────

  testWidgets('summary row shows correct total count', (tester) async {
    await _pumpWithState(tester, PushWeekDone(_makePartialFailure()));
    // total = 2
    expect(find.text('2'), findsAtLeastNWidgets(1));
  });
}
