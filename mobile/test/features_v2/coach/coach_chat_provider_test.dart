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
  'base_revision': '4',
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
      {
        'id': '$diffId-rejected',
        'op': 'replace_phase_focus',
        'accepted': false,
      },
    ],
    'ai_explanation': label,
    'created_at': '2026-07-15T00:00:00Z',
  },
};

class _FakeApi extends StrideApi {
  _FakeApi({this.failFirstChat = false}) : super(Dio());

  final bool failFirstChat;
  int chatCalls = 0;
  final List<String> clientTurnIds = [];
  Map<String, dynamic>? appliedDiff;
  List<String>? acceptedOpIds;
  String? appliedSessionId;
  String? appliedBaseRevision;
  Map<String, dynamic>? abandonedTarget;
  String? abandonedSessionId;

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
  postCoachChat({
    required String sessionId,
    required String message,
    required String clientTurnId,
  }) async {
    chatCalls += 1;
    clientTurnIds.add(clientTurnId);
    if (failFirstChat && chatCalls == 1) throw Exception('network dropped');
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
    required String sessionId,
    required String planId,
    required Map<String, dynamic> diff,
    required List<String> acceptedOpIds,
    required String baseRevision,
    String changeReason = 'coach adjustment',
  }) async {
    appliedSessionId = sessionId;
    appliedBaseRevision = baseRevision;
    appliedDiff = diff;
    this.acceptedOpIds = acceptedOpIds;
    return {'version': 5};
  }

  @override
  Future<void> abandonCoachProposal({
    required String sessionId,
    required Map<String, dynamic> target,
    String summary = '用户放弃了本次调整方案',
  }) async {
    abandonedSessionId = sessionId;
    abandonedTarget = target;
  }

  @override
  Future<List<({String role, String text})>> getCoachThread(
    String threadId,
  ) async {
    final event = abandonedTarget == null ? '已应用赛季计划调整' : '已放弃本次调整方案';
    return [
      (role: 'user', text: '给我两个调整方案'),
      (role: 'assistant', text: '请选择一个调整方向'),
      (role: 'event', text: event),
    ];
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
      expect(api.appliedBaseRevision, '4');
      expect(api.appliedSessionId, startsWith('qa-'));
      expect(state.proposals, isEmpty);
      expect(state.selectedProposalId, isNull);
      expect(state.messages.last.role, 'event');
      expect(state.messages.last.text, '已应用赛季计划调整');
    },
  );

  test(
    'reuses the same client turn id when a failed message is retried',
    () async {
      final api = _FakeApi(failFirstChat: true);
      final notifier = CoachChatNotifier(
        api,
        sessionId: 'qa-test',
        clientTurnIdFactory: () => 'stable-turn-id',
      );
      addTearDown(notifier.dispose);

      await notifier.sendMessage('今天怎么跑？');
      expect(notifier.state.error, isNotNull);
      await notifier.sendMessage('今天怎么跑？');

      expect(api.clientTurnIds, ['stable-turn-id', 'stable-turn-id']);
      expect(
        notifier.state.messages.where((message) => message.isUser),
        hasLength(1),
      );
    },
  );

  test('records proposal abandonment and reloads the trusted event', () async {
    final api = _FakeApi();
    final notifier = CoachChatNotifier(
      api,
      sessionId: 'qa-test',
      clientTurnIdFactory: () => 'turn-1',
    );
    addTearDown(notifier.dispose);

    await notifier.sendMessage('给我两个调整方案');
    await notifier.dismissProposals();

    expect(api.abandonedSessionId, 'qa-test');
    expect(api.abandonedTarget, {'kind': 'master', 'plan_id': 'plan-1'});
    expect(notifier.state.messages.last.role, 'event');
    expect(notifier.state.messages.last.text, '已放弃本次调整方案');
  });

  testWidgets('shows both proposal cards and applies the selected direction', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
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
    expect(find.text('已应用赛季计划调整'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^Coach 事件')), findsOneWidget);
    expect(find.byKey(const Key('coach-proposal-chooser')), findsNothing);
    semantics.dispose();
  });
}
