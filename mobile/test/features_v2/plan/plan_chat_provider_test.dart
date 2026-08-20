import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/plan/providers/plan_chat_provider.dart';

const _folder = '2026-07-20_07-26';

Map<String, dynamic> _diff() => {
  'diff_id': 'weekly-diff-1',
  'folder': _folder,
  'ops': [
    {
      'id': 'op-1',
      'op': 'replace_distance',
      'date': '2026-07-22',
      'session_index': 0,
      'accepted': null,
    },
    {
      'id': 'op-rejected',
      'op': 'remove_session',
      'date': '2026-07-24',
      'session_index': 0,
      'accepted': false,
    },
  ],
  'ai_explanation': '本周整单调整',
  'created_at': '2026-07-19T00:00:00Z',
};

class _FakeWeeklyApi extends StrideApi {
  _FakeWeeklyApi({this.failFirstChat = false}) : super(Dio());

  final bool failFirstChat;
  int chatCalls = 0;
  final List<String> clientTurnIds = [];
  List<String>? appliedOpIds;
  String? appliedBaseRevision;
  Map<String, dynamic>? appliedDiff;

  @override
  Future<
    ({
      String reply,
      String? clarification,
      Map<String, dynamic>? diff,
      String baseRevision,
    })
  >
  sendWeeklyAdjustMessage({
    required String folder,
    required String message,
    required String clientTurnId,
  }) async {
    chatCalls += 1;
    clientTurnIds.add(clientTurnId);
    if (failFirstChat && chatCalls == 1) throw Exception('network dropped');
    return (
      reply: '已生成整单调整',
      clarification: null,
      diff: _diff(),
      baseRevision: 'weekly-sha',
    );
  }

  @override
  Future<Map<String, dynamic>> applyWeeklyAdjustDiff({
    required String folder,
    required Map<String, dynamic> diff,
    required List<String> acceptedOpIds,
    required String baseRevision,
  }) async {
    appliedDiff = diff;
    appliedOpIds = acceptedOpIds;
    appliedBaseRevision = baseRevision;
    return {'applied': acceptedOpIds.length};
  }
}

void main() {
  test(
    'keeps the weekly fingerprint and selects every applicable op',
    () async {
      final api = _FakeWeeklyApi();
      final notifier = PlanChatNotifier(api, null, () => 'weekly-turn-1');
      addTearDown(notifier.dispose);

      await notifier.sendMessage(_folder, '本周减量');

      expect(api.clientTurnIds, ['weekly-turn-1']);
      expect(notifier.state.baseRevision, 'weekly-sha');
      expect(notifier.state.acceptedOpIds, {'op-1'});
      notifier.toggleOp('op-1');
      expect(notifier.state.acceptedOpIds, {'op-1'});

      await notifier.applyDiff(_folder);
      expect(api.appliedDiff?['diff_id'], 'weekly-diff-1');
      expect(api.appliedOpIds, ['op-1']);
      expect(api.appliedBaseRevision, 'weekly-sha');
      expect(notifier.state.pendingDiff, isNull);
    },
  );

  test('reuses the weekly turn id after a dropped response', () async {
    final api = _FakeWeeklyApi(failFirstChat: true);
    final notifier = PlanChatNotifier(api, null, () => 'stable-weekly-turn');
    addTearDown(notifier.dispose);

    await notifier.sendMessage(_folder, '本周减量');
    expect(notifier.state.error, isNotNull);
    await notifier.sendMessage(_folder, '本周减量');

    expect(api.clientTurnIds, ['stable-weekly-turn', 'stable-weekly-turn']);
    expect(
      notifier.state.messages.where((message) => message.role == 'user'),
      hasLength(1),
    );
  });
}
