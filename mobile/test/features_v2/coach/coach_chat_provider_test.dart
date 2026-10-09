import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/coach/coach_chat_screen.dart';
import 'package:stride/features_v2/coach/providers/coach_chat_provider.dart';

class _FakeApi extends StrideApi {
  _FakeApi({this.failFirstChat = false}) : super(Dio());

  final bool failFirstChat;
  int chatCalls = 0;
  final List<String> clientTurnIds = [];

  @override
  Future<CoachChatReply> postCoachChat({
    required String sessionId,
    required String message,
    required String clientTurnId,
  }) async {
    chatCalls += 1;
    clientTurnIds.add(clientTurnId);
    if (failFirstChat && chatCalls == 1) throw Exception('network dropped');
    return CoachChatReply(
      sessionId: sessionId,
      threadId: 'user:coach:$sessionId',
      reply: '今天状态不错，按计划轻松跑即可。',
      clarification: null,
    );
  }
}

void main() {
  test('sends a message and appends the assistant reply', () async {
    final api = _FakeApi();
    final notifier = CoachChatNotifier(
      api,
      sessionId: 'qa-test',
      clientTurnIdFactory: () => 'turn-1',
    );
    addTearDown(notifier.dispose);

    await notifier.sendMessage('今天怎么跑？');

    expect(notifier.state.error, isNull);
    expect(notifier.state.loading, isFalse);
    expect(notifier.state.threadId, 'user:coach:qa-test');
    expect(notifier.state.messages, hasLength(2));
    expect(notifier.state.messages.first.role, 'user');
    expect(notifier.state.messages.first.text, '今天怎么跑？');
    expect(notifier.state.messages.last.role, 'assistant');
  });

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

  testWidgets('renders the transcript and accepts pending context', (
    tester,
  ) async {
    final api = _FakeApi();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          strideApiProvider.overrideWithValue(api),
          pendingCoachMessageProvider.overrideWith((ref) => '关于 10月12日 的「轻松跑」'),
        ],
        child: const MaterialApp(home: CoachChatScreen()),
      ),
    );
    await tester.pump();

    // 跨页交接的预填消息进入输入框。
    expect(find.widgetWithText(TextField, '关于 10月12日 的「轻松跑」'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '今天怎么跑？');
    await tester.tap(find.byIcon(Icons.send_rounded));
    await tester.pumpAndSettle();

    expect(find.text('今天状态不错，按计划轻松跑即可。'), findsOneWidget);
  });
}
