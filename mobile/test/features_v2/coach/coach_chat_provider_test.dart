import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/coach/coach_chat_screen.dart';
import 'package:stride/features_v2/coach/providers/coach_chat_provider.dart';

Map<String, dynamic> _proposal(String diffId, String label) => {
  'specialist_id': 'season_plan',
  'summary': label,
  'proposal': {
    'diff_id': diffId,
    'plan_id': 'plan-1',
    'ops': [
      {
        'id': '$diffId-op',
        'op': 'replace_weekly_range',
        'phase_id': 'build',
        'old_value': {
          'weekly_distance_km_low': 50,
          'weekly_distance_km_high': 60,
        },
        'new_value': {
          'weekly_distance_km_low': 45,
          'weekly_distance_km_high': 54,
        },
        'spec_patch': {
          'weekly_distance_km_low': 45,
          'weekly_distance_km_high': 54,
        },
      },
    ],
    'ai_explanation': label,
    'created_at': '2026-07-15T00:00:00Z',
  },
};

class _FakeApi extends StrideApi {
  _FakeApi() : super(Dio());

  Map<String, dynamic>? appliedDiff;
  List<String>? acceptedOpIds;

  @override
  Future<
    ({
      String sessionId,
      String threadId,
      String reply,
      String? clarification,
      List<Map<String, dynamic>> proposals,
    })
  >
  postCoachChat({required String sessionId, required String message}) async {
    return (
      sessionId: sessionId,
      threadId: 'user:coach:$sessionId',
      reply: '请选择一个调整方向',
      clarification: null,
      proposals: [
        _proposal('diff-a', '方案 A（温和减量）'),
        _proposal('diff-b', '方案 B（明显减量）'),
      ],
    );
  }

  @override
  Future<Map<String, dynamic>> applyCoachMasterPlanDiff({
    required String planId,
    required Map<String, dynamic> diff,
    required List<String> acceptedOpIds,
    String changeReason = 'coach adjustment',
  }) async {
    appliedDiff = diff;
    this.acceptedOpIds = acceptedOpIds;
    return {'version': 2};
  }
}

void main() {
  test(
    'retains all proposals and applies the user-selected complete diff',
    () async {
      final api = _FakeApi();
      final container = ProviderContainer(
        overrides: [strideApiProvider.overrideWithValue(api)],
      );
      addTearDown(container.dispose);
      final subscription = container.listen(
        coachChatProvider,
        (_, _) {},
        fireImmediately: true,
      );
      addTearDown(subscription.close);
      final notifier = container.read(coachChatProvider.notifier);

      await notifier.sendMessage('给我两个调整方案');

      var state = container.read(coachChatProvider);
      expect(state.proposals, hasLength(2));
      expect(state.selectedProposalId, 'diff-a');

      notifier.selectProposal('diff-b');
      await notifier.applySelectedProposal();

      state = container.read(coachChatProvider);
      expect(api.appliedDiff?['diff_id'], 'diff-b');
      expect(api.acceptedOpIds, ['diff-b-op']);
      expect(state.proposals, isEmpty);
      expect(state.selectedProposalId, isNull);
      expect(state.messages.last.text, contains('v2'));
    },
  );

  testWidgets('shows both proposal cards and applies the selected direction', (
    tester,
  ) async {
    final api = _FakeApi();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [strideApiProvider.overrideWithValue(api)],
        child: const MaterialApp(home: CoachChatScreen()),
      ),
    );

    await tester.enterText(find.byType(TextField), '给我两个调整方案');
    await tester.tap(find.byIcon(Icons.send_rounded));
    await tester.pumpAndSettle();

    expect(find.text('方案 A（温和减量）'), findsOneWidget);
    expect(find.text('方案 B（明显减量）'), findsOneWidget);
    expect(find.text('应用所选方案'), findsOneWidget);

    await tester.tap(find.byKey(const Key('coach-proposal-diff-b')));
    await tester.tap(find.byKey(const Key('apply-coach-proposal')));
    await tester.pumpAndSettle();

    expect(api.appliedDiff?['diff_id'], 'diff-b');
    expect(find.textContaining('训练计划已更新至 v2'), findsOneWidget);
    expect(find.byKey(const Key('coach-proposal-chooser')), findsNothing);
  });
}
