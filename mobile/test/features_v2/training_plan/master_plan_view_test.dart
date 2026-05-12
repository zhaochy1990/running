/// Tests for C6 MasterPlanViewScreen, C7 MasterPlanAdjustScreen,
/// C8 MasterPlanHistoryScreen and MasterPlanVersionScreen.
library;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/training_plan/master_plan_view_screen.dart';
import 'package:stride/features_v2/training_plan/adjust_screen.dart';
import 'package:stride/features_v2/training_plan/history_screen.dart';
import 'package:stride/features_v2/training_plan/version_screen.dart';
import 'package:stride/features_v2/training_plan/models/master_plan.dart';

// ── Fake data ─────────────────────────────────────────────────────────────────

const _kPlanId = 'plan-001';
const _kPhaseId = 'phase-001';
const _kMsId = 'ms-001';

MasterPlan _makePlan() => MasterPlan.fromJson({
      'plan_id': _kPlanId,
      'user_id': 'user-001',
      'status': 'active',
      'goal_id': 'goal-001',
      'start_date': '2026-05-12',
      'end_date': '2026-10-26',
      'phases': [
        {
          'id': _kPhaseId,
          'name': '基础期',
          'start_date': '2026-05-12',
          'end_date': '2026-07-06',
          'focus': '有氧基础训练',
          'weekly_distance_km_low': 40.0,
          'weekly_distance_km_high': 50.0,
          'key_session_types': ['长距离', '有氧'],
          'milestone_ids': [_kMsId],
        }
      ],
      'milestones': [
        {
          'id': _kMsId,
          'type': 'test_run',
          'date': '2026-07-05',
          'phase_id': _kPhaseId,
          'target': '30K 测试跑 4\'55/km',
          'completed_actual': null,
        }
      ],
      'training_principles': ['渐进原则', '充足休息'],
      'generated_by': 'gpt-4.1',
      'version': 1,
      'created_at': '2026-05-12T00:00:00Z',
      'updated_at': '2026-05-12T00:00:00Z',
      'current_phase_id': _kPhaseId,
      'current_week_number': 3,
      'total_weeks': 24,
      'next_milestone': {
        'id': _kMsId,
        'date': '2026-07-05',
        'target': '30K 测试跑',
        'days_until': 54,
      },
    });

// ── Fake API ──────────────────────────────────────────────────────────────────

class FakeStrideApi extends StrideApi {
  FakeStrideApi({
    this.planToReturn,
    this.versionsToReturn = const [],
    this.failWith,
  }) : super(Dio());

  final MasterPlan? planToReturn;
  final List<MasterPlanVersionSummary> versionsToReturn;
  final Exception? failWith;

  @override
  Future<MasterPlan?> getCurrentMasterPlan() async {
    if (failWith != null) throw failWith!;
    return planToReturn;
  }

  @override
  Future<Map<String, dynamic>> getMasterPlan(String planId) async {
    if (failWith != null) throw failWith!;
    return planToReturn != null
        ? {
            'plan_id': planToReturn!.planId,
            'start_date': planToReturn!.startDate,
            'end_date': planToReturn!.endDate,
            'total_weeks': planToReturn!.totalWeeks,
            'phase_count': planToReturn!.phases.length,
            'milestone_count': planToReturn!.milestones.length,
            'status': planToReturn!.status,
          }
        : {};
  }

  @override
  Future<Map<String, dynamic>> sendMasterPlanAdjustMessage({
    required String planId,
    required String message,
    List<Map<String, dynamic>>? history,
  }) async {
    return {'ai_response': '已收到调整请求', 'diff': null};
  }

  @override
  Future<List<MasterPlanVersionSummary>> listMasterPlanVersions(
      String planId) async {
    if (failWith != null) throw failWith!;
    return versionsToReturn;
  }

  @override
  Future<Map<String, dynamic>> getMasterPlanVersion(
      String planId, int version) async {
    if (planToReturn != null) {
      // Return a minimal valid plan JSON
      return {
        'plan_id': planToReturn!.planId,
        'user_id': 'user-001',
        'status': 'active',
        'goal_id': 'goal-001',
        'start_date': planToReturn!.startDate,
        'end_date': planToReturn!.endDate,
        'phases': planToReturn!.phases
            .map((p) => {
                  'id': p.id,
                  'name': p.name,
                  'start_date': p.startDate,
                  'end_date': p.endDate,
                  'focus': p.focus,
                  'weekly_distance_km_low': p.weeklyDistanceKmLow,
                  'weekly_distance_km_high': p.weeklyDistanceKmHigh,
                  'key_session_types': p.keySessionTypes,
                  'milestone_ids': p.milestoneIds,
                })
            .toList(),
        'milestones': planToReturn!.milestones
            .map((m) => {
                  'id': m.id,
                  'type': m.type.name == 'testRun' ? 'test_run' : m.type.name,
                  'date': m.date,
                  'phase_id': m.phaseId,
                  'target': m.target,
                  'completed_actual': m.completedActual,
                })
            .toList(),
        'training_principles': planToReturn!.trainingPrinciples,
        'generated_by': planToReturn!.generatedBy,
        'version': version,
        'created_at': planToReturn!.createdAt,
        'updated_at': planToReturn!.updatedAt,
      };
    }
    throw Exception('not found');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

Widget _wrap(Widget screen, {FakeStrideApi? api, List<GoRoute> extra = const []}) {
  final fakeApi = api ?? FakeStrideApi(planToReturn: _makePlan());
  final router = GoRouter(
    routes: [
      GoRoute(path: '/', builder: (_, __) => screen),
      GoRoute(
        path: '/v2/training-plan/adjust/:planId',
        builder: (_, state) =>
            MasterPlanAdjustScreen(planId: state.pathParameters['planId']!),
      ),
      GoRoute(
        path: '/v2/training-plan/history/:planId',
        builder: (_, state) =>
            MasterPlanHistoryScreen(planId: state.pathParameters['planId']!),
      ),
      ...extra,
    ],
  );
  return ProviderScope(
    overrides: [strideApiProvider.overrideWithValue(fakeApi)],
    child: MaterialApp.router(routerConfig: router),
  );
}

// ===========================================================================
// C6 — MasterPlanViewScreen
// ===========================================================================

void main() {
  group('C6 MasterPlanViewScreen', () {
    testWidgets('renders without crash when plan exists', (tester) async {
      await tester.pumpWidget(_wrap(const MasterPlanViewScreen()));
      await tester.pump(); // allow FutureProvider to settle
      await tester.pump(const Duration(milliseconds: 100));
      // Should not throw
      expect(find.byType(MasterPlanViewScreen), findsOneWidget);
    });

    testWidgets('shows no-plan placeholder when 404', (tester) async {
      final api = FakeStrideApi(planToReturn: null);
      await tester.pumpWidget(_wrap(const MasterPlanViewScreen(), api: api));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('暂无激活的训练总纲'), findsOneWidget);
    });

    testWidgets('shows phase name in hero card', (tester) async {
      await tester.pumpWidget(_wrap(const MasterPlanViewScreen()));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('基础期'), findsWidgets);
    });

    testWidgets('shows milestone target', (tester) async {
      await tester.pumpWidget(_wrap(const MasterPlanViewScreen()));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      // MilestoneRow shows target text
      expect(find.textContaining('测试跑'), findsWidgets);
    });

    testWidgets('shows adjust and history icons in appbar', (tester) async {
      await tester.pumpWidget(_wrap(const MasterPlanViewScreen()));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byIcon(Icons.tune), findsOneWidget);
      expect(find.byIcon(Icons.history), findsOneWidget);
    });
  });

  // ===========================================================================
  // C7 — MasterPlanAdjustScreen
  // ===========================================================================

  group('C7 MasterPlanAdjustScreen', () {
    testWidgets('renders without crash', (tester) async {
      await tester.pumpWidget(
        _wrap(const MasterPlanAdjustScreen(planId: _kPlanId)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(MasterPlanAdjustScreen), findsOneWidget);
    });

    testWidgets('shows title 调整训练总纲', (tester) async {
      await tester.pumpWidget(
        _wrap(const MasterPlanAdjustScreen(planId: _kPlanId)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('调整训练总纲'), findsOneWidget);
    });

    testWidgets('shows suggestion chips', (tester) async {
      await tester.pumpWidget(
        _wrap(const MasterPlanAdjustScreen(planId: _kPlanId)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('比赛延期到 12 月 20 日'), findsOneWidget);
      expect(find.text('降低强度一档'), findsOneWidget);
    });

    testWidgets('shows empty state placeholder', (tester) async {
      await tester.pumpWidget(
        _wrap(const MasterPlanAdjustScreen(planId: _kPlanId)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('向 AI 教练发送消息\n调整当前训练总纲'), findsOneWidget);
    });
  });

  // ===========================================================================
  // C8 — MasterPlanHistoryScreen
  // ===========================================================================

  group('C8 MasterPlanHistoryScreen', () {
    testWidgets('shows empty history message', (tester) async {
      final api = FakeStrideApi(planToReturn: _makePlan(), versionsToReturn: []);
      await tester.pumpWidget(
        _wrap(const MasterPlanHistoryScreen(planId: _kPlanId), api: api),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('暂无调整历史'), findsOneWidget);
    });

    testWidgets('shows version cards when versions exist', (tester) async {
      final versions = [
        MasterPlanVersionSummary.fromJson({
          'version_id': 'v1',
          'version': 2,
          'changed_at': '2026-05-20T10:00:00Z',
          'change_reason': '比赛延期',
          'change_summary': '进展期延长 2 周',
        }),
        MasterPlanVersionSummary.fromJson({
          'version_id': 'v2',
          'version': 1,
          'changed_at': '2026-05-12T08:00:00Z',
          'change_reason': '初始确认',
          'change_summary': '生成并确认总纲',
        }),
      ];
      final api =
          FakeStrideApi(planToReturn: _makePlan(), versionsToReturn: versions);
      await tester.pumpWidget(
        _wrap(const MasterPlanHistoryScreen(planId: _kPlanId), api: api),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('比赛延期'), findsOneWidget);
      expect(find.text('初始确认'), findsOneWidget);
      expect(find.text('V2'), findsOneWidget);
      expect(find.text('V1'), findsOneWidget);
    });

    testWidgets('renders without crash', (tester) async {
      await tester.pumpWidget(
        _wrap(const MasterPlanHistoryScreen(planId: _kPlanId)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(MasterPlanHistoryScreen), findsOneWidget);
    });
  });

  // ===========================================================================
  // C8 — MasterPlanVersionScreen
  // ===========================================================================

  group('C8 MasterPlanVersionScreen', () {
    testWidgets('renders snapshot without crash', (tester) async {
      await tester.pumpWidget(
        _wrap(const MasterPlanVersionScreen(planId: _kPlanId, version: 1)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(MasterPlanVersionScreen), findsOneWidget);
    });

    testWidgets('shows version title', (tester) async {
      await tester.pumpWidget(
        _wrap(const MasterPlanVersionScreen(planId: _kPlanId, version: 1)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('版本 V1 快照'), findsOneWidget);
    });

    testWidgets('shows phase name from snapshot', (tester) async {
      await tester.pumpWidget(
        _wrap(const MasterPlanVersionScreen(planId: _kPlanId, version: 1)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('基础期'), findsWidgets);
    });
  });

  // ===========================================================================
  // MasterPlan model tests
  // ===========================================================================

  group('MasterPlan model', () {
    test('fromJson parses all fields correctly', () {
      final plan = _makePlan();
      expect(plan.planId, _kPlanId);
      expect(plan.phases.length, 1);
      expect(plan.phases[0].name, '基础期');
      expect(plan.milestones.length, 1);
      expect(plan.milestones[0].type, MilestoneType.testRun);
      expect(plan.currentPhaseId, _kPhaseId);
      expect(plan.currentWeekNumber, 3);
      expect(plan.totalWeeks, 24);
      expect(plan.nextMilestone?.daysUntil, 54);
    });

    test('completionRatio computed correctly', () {
      final plan = _makePlan(); // week 3 of 24
      expect(plan.completionRatio, closeTo(3.0 / 24.0, 0.001));
    });

    test('completionRatio returns 0 when totalWeeks is null', () {
      final plan = MasterPlan.fromJson({
        'plan_id': 'p1',
        'user_id': 'u1',
        'status': 'active',
        'goal_id': 'g1',
        'start_date': '2026-05-12',
        'end_date': '2026-10-26',
        'phases': [],
        'milestones': [],
        'training_principles': [],
        'generated_by': 'gpt-4.1',
        'version': 1,
        'created_at': '2026-05-12T00:00:00Z',
        'updated_at': '2026-05-12T00:00:00Z',
      });
      expect(plan.completionRatio, 0.0);
    });

    test('MasterPlanVersionSummary.fromJson parses correctly', () {
      final v = MasterPlanVersionSummary.fromJson({
        'version_id': 'vid-1',
        'version': 3,
        'changed_at': '2026-06-01T10:00:00Z',
        'change_reason': '调整原因',
        'change_summary': '调整摘要',
      });
      expect(v.version, 3);
      expect(v.changeReason, '调整原因');
    });
  });
}
