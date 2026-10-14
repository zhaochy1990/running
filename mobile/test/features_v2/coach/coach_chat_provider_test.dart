import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/auth_models.dart';
import 'package:stride/core/auth/auth_repository.dart';
import 'package:stride/data/api/coach_turn_id.dart';
import 'package:stride/data/coach/coach_api.dart';
import 'package:stride/data/coach/coach_cards.dart';
import 'package:stride/features_v2/coach/providers/coach_chat_provider.dart';

class _RecordedTurn {
  _RecordedTurn(this.message, this.sessionId, this.clientTurnId, this.target);

  final String message;
  final String sessionId;
  final String clientTurnId;
  final CoachTarget? target;
}

class _FakeCoachApi extends CoachApi {
  _FakeCoachApi() : super(baseUrl: 'https://coach.test', clientId: 'test', auth: _FakeAuth());

  final turns = <_RecordedTurn>[];
  List<Map<String, dynamic>> sessions = [];
  Map<String, List<CoachHistoryMessage>> history = {};
  bool failTurns = false;

  @override
  CoachStreamHandle sendCoachChatStream({
    required String message,
    required String sessionId,
    required String clientTurnId,
    CoachTarget? target,
    CoachStreamCallbacks callbacks = const CoachStreamCallbacks(),
  }) {
    turns.add(_RecordedTurn(message, sessionId, clientTurnId, target));
    // 异步 canned stream（微任务投递）：让 sendMessage 返回时轮次仍在途。
    scheduleMicrotask(() {
      if (failTurns) {
        callbacks.onError
            ?.call(const CoachStreamError('coach_turn_failed', 'coach turn failed'));
        return;
      }
      // status → delta → done（done.message 为权威正文）。
      callbacks.onEvent?.call(
        const CoachStreamStatus(CoachStatusEvent(phase: 'running_tool', toolStatus: 'running')),
      );
      callbacks.onEvent?.call(const CoachStreamDelta('拼接出来的'));
      callbacks.onComplete?.call(const CoachDone(
        status: 'completed',
        message: '今天按计划轻松跑即可。',
      ));
    });
    return CoachStreamHandle(() {});
  }

  @override
  Future<List<CoachSessionSummary>> fetchSessions() async => [
        for (final s in sessions)
          CoachSessionSummary(
            sessionId: s['session_id'] as String,
            preview: s['preview'] as String?,
          ),
      ];

  @override
  Future<CoachHistoryResponse> fetchHistory(String sessionId) async =>
      CoachHistoryResponse(sessionId: sessionId, messages: history[sessionId] ?? const []);
}

class _FakeAuth extends AuthRepository {
  @override
  Future<TokenSet?> currentTokens() async => null;

  @override
  Future<TokenSet> refresh(TokenSet current) async => throw UnimplementedError();
}

void main() {
  Future<void> flushThrottle() => Future<void>.delayed(const Duration(milliseconds: 40));

  test('send streams: user bubble → streaming → authoritative done bubble', () async {
    final api = _FakeCoachApi();
    final notifier = CoachChatNotifier(api);
    addTearDown(notifier.dispose);

    notifier.sendMessage('今天怎么跑？');
    expect(notifier.state.streaming, isTrue);
    expect(notifier.state.messages.last.role, 'user');
    expect(notifier.state.messages.last.content, '今天怎么跑？');

    await flushThrottle();
    expect(notifier.state.streaming, isFalse);
    // done.message 重写正文：流内拼接的「拼接出来的」不进最终气泡。
    expect(notifier.state.messages.last.content, '今天按计划轻松跑即可。');
    expect(notifier.state.streamText, isEmpty);
    // 每轮 body 携带 flutter- 前缀 session id + 幂等 turn id。
    expect(api.turns.single.sessionId, startsWith('flutter-'));
    expect(api.turns.single.clientTurnId, matches(RegExp(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')));
  });

  test('failed turn marks retry; retry reuses the same client_turn_id + body', () async {
    final api = _FakeCoachApi()..failTurns = true;
    final notifier = CoachChatNotifier(api);
    addTearDown(notifier.dispose);

    notifier.sendMessage('状态怎么样？');
    await flushThrottle();
    final failedMsg = notifier.state.messages.last;
    expect(failedMsg.failed, isTrue);
    expect(notifier.state.streaming, isFalse);

    notifier.retry(failedMsg.id);
    expect(notifier.state.streaming, isTrue);
    expect(api.turns, hasLength(2));
    // 幂等重试：同 turn id、同 session、同消息（逐字节同 body 的前提）。
    expect(api.turns[1].clientTurnId, api.turns[0].clientTurnId);
    expect(api.turns[1].message, api.turns[0].message);
    expect(api.turns[1].sessionId, api.turns[0].sessionId);
  });

  test('same-session concurrency is rejected (queued = no-op while streaming)', () async {
    final api = _FakeCoachApi();
    final notifier = CoachChatNotifier(api);
    addTearDown(notifier.dispose);

    notifier.sendMessage('第一条');
    notifier.sendMessage('第二条');
    expect(api.turns, hasLength(1));
    await flushThrottle();
  });

  test('history rows restore cards: server envelope first, leaked JSON self-heal', () async {
    final strategy = {
      'race_name': '上马',
      'item_type': 'full',
      'target_finish_time': '3:30:00',
      'pace_segments': [
        {'segment': '0-5', 'pace': '5:00', 'distance_km': 5, 'segment_time': '25:00', 'cumulative_time': '25:00', 'note': ''},
      ],
    };
    final api = _FakeCoachApi()
      ..history = {
        'flutter-1': [
          const CoachHistoryMessage(role: 'user', content: '生成比赛策略'),
          CoachHistoryMessage(role: 'assistant', content: '正文', card: {
            r'$type': 'race-strategy',
            'data': strategy,
          }),
          const CoachHistoryMessage(role: 'assistant', content: '{"disposition":"return_direct","content":{"race_name":"旧策略","item_type":"full","target_finish_time":"4:00:00","pace_segments":[{"segment":"0-5","pace":"5:40","distance_km":5,"segment_time":"28:20","cumulative_time":"28:20","note":""}]}}'),
        ],
      };
    final notifier = CoachChatNotifier(api);
    addTearDown(notifier.dispose);

    await notifier.selectSession('flutter-1');
    expect(notifier.state.currentSessionId, 'flutter-1');
    final msgs = notifier.state.messages;
    expect(msgs, hasLength(3));
    expect(msgs[1].card?.type, 'race-strategy');
    expect(msgs[1].card?.title, '比赛策略已生成');
    // 泄漏信封自愈：形似信封的历史文本捞回成卡片。
    expect(msgs[2].card?.type, 'race-strategy');
    final old = msgs[2].card!.data as Map<String, dynamic>;
    expect(old['race_name'], '旧策略');
  });

  test('pending context creates a race-anchored session; draft handoff is gated on it',
      () async {
    final api = _FakeCoachApi();
    PendingStrategyDraft? handedOff;
    final notifier = CoachChatNotifier(api, onStrategyDraft: (d) => handedOff = d);
    addTearDown(notifier.dispose);

    notifier.consumePendingContext(const PendingCoachContext(
      target: CoachTarget(kind: 'race', raceEventId: 42, itemType: 'full_marathon'),
      label: '上马 · 全马',
    ));
    expect(notifier.state.currentSessionId, startsWith('flutter-'));
    expect(notifier.state.sessionOf(notifier.state.currentSessionId)!.target?.kind, 'race');

    // 先发一条让 done 卡片出现在消息里？canned done 无 card —— 直接验证门控：
    final msgId = notifier.state.messages.isEmpty ? 1 : notifier.state.messages.last.id;
    // 无卡片消息 → 交接失败。
    expect(notifier.openStrategyCard(msgId), isFalse);
    expect(handedOff, isNull);

    notifier.sendMessage('生成策略');
    await flushThrottle();
    final assistantId = notifier.state.messages.last.id;
    // session 有 race target，但本轮 done 无卡片 → 仍不交接。
    expect(notifier.openStrategyCard(assistantId), isFalse);
    expect(handedOff, isNull);
  });

  test('loadSessions merges server rows and keeps local-only sessions', () async {
    final api = _FakeCoachApi()
      ..sessions = [
        {'session_id': 'qa-2026-10-01', 'preview': '昨天问我HRV'},
        {'session_id': 'week-2026-W41', 'preview': '这周调整'},
      ];
    final notifier = CoachChatNotifier(api);
    addTearDown(notifier.dispose);

    await notifier.loadSessions();
    final ids = notifier.state.sessions.map((s) => s.id).toList();
    // 存量 qa-*/week-* 会话经服务端列表延续；本地默认会话保留（服务端未落库）。
    expect(ids, containsAll(['qa-2026-10-01', 'week-2026-W41', kDefaultCoachSessionId]));
    final qa = notifier.state.sessions.firstWhere((s) => s.id == 'qa-2026-10-01');
    expect(qa.title, '昨天问我HRV');
  });

  test('id factories: session flutter- prefix, turn id matches the server regex', () {
    final sessionId = createCoachSessionId();
    expect(sessionId, startsWith('flutter-'));
    expect(sessionId, matches(RegExp(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')));
    expect(createCoachClientTurnId(), matches(RegExp(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')));
  });
}
