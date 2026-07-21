import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/data/api/stride_api.dart';

class _RecordingInterceptor extends Interceptor {
  RequestOptions? lastRequest;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    lastRequest = options;
    final rawBody = options.data;
    final body = rawBody is Map<String, dynamic>
        ? rawBody
        : const <String, dynamic>{};
    final responseBody = switch (options.path) {
      '/api/users/me/coach/chat' => <String, dynamic>{
        'session_id': body['session_id'],
        'thread_id': 'user:coach:${body['session_id']}',
        'reply': 'ok',
        'clarification': null,
        'proposals': <Object>[],
      },
      '/api/users/me/coach/master-plan/plan-1/apply' => <String, dynamic>{
        'applied': 1,
        'version': 5,
      },
      '/api/users/me/coach/plan/week-1/apply' => <String, dynamic>{
        'applied': 1,
      },
      '/api/users/me/coach/proposals/abandon' => <String, dynamic>{
        'recorded': true,
      },
      '/api/users/me/coach/threads/user:coach:qa-test/messages' =>
        <String, dynamic>{
          'messages': [
            {
              'role': 'event',
              'content': '',
              'summary': '已应用赛季计划调整',
              'parts': <Object>[],
            },
          ],
        },
      _ => <String, dynamic>{},
    };
    handler.resolve(
      Response<Map<String, dynamic>>(
        requestOptions: options,
        statusCode: 200,
        data: responseBody,
      ),
    );
  }
}

void main() {
  late _RecordingInterceptor recorder;
  late StrideApi api;

  setUp(() {
    recorder = _RecordingInterceptor();
    final dio = Dio(BaseOptions(baseUrl: 'https://stride.test'));
    dio.interceptors.add(recorder);
    api = StrideApi(dio);
  });

  test('daily coach chat sends the required idempotency key', () async {
    await api.postCoachChat(
      sessionId: 'qa-2026-07-19',
      message: '今天怎么跑？',
      clientTurnId: 'mobile-turn-1',
    );

    expect(recorder.lastRequest?.data, {
      'session_id': 'qa-2026-07-19',
      'message': '今天怎么跑？',
      'client_turn_id': 'mobile-turn-1',
    });
  });

  test('weekly coach chat sends turn id and authoritative target', () async {
    await api.sendWeeklyAdjustMessage(
      folder: 'week-1',
      message: '本周减量',
      clientTurnId: 'mobile-week-turn-1',
    );

    expect(recorder.lastRequest?.data, {
      'session_id': 'week-week-1',
      'message': '本周减量',
      'client_turn_id': 'mobile-week-turn-1',
      'target': {'kind': 'week', 'folder': 'week-1'},
    });
  });

  test('master apply sends session and proposal base revision', () async {
    await api.applyCoachMasterPlanDiff(
      sessionId: 'qa-2026-07-19',
      planId: 'plan-1',
      diff: {'plan_id': 'plan-1', 'ops': <Object>[]},
      acceptedOpIds: const ['op-1'],
      baseRevision: '4',
    );

    expect(recorder.lastRequest?.data, {
      'session_id': 'qa-2026-07-19',
      'diff': {'plan_id': 'plan-1', 'ops': <Object>[]},
      'accepted_op_ids': ['op-1'],
      'change_reason': 'coach adjustment',
      'base_revision': '4',
    });
  });

  test('weekly apply sends its chat session and base revision', () async {
    await api.applyWeeklyAdjustDiff(
      folder: 'week-1',
      diff: {'folder': 'week-1', 'ops': <Object>[]},
      acceptedOpIds: const ['op-1'],
      baseRevision: 'weekly-sha',
    );

    expect(recorder.lastRequest?.data, {
      'session_id': 'week-week-1',
      'diff': {'folder': 'week-1', 'ops': <Object>[]},
      'accepted_op_ids': ['op-1'],
      'base_revision': 'weekly-sha',
    });
  });

  test('trusted event history uses its summary as visible text', () async {
    final history = await api.getCoachThread('user:coach:qa-test');

    expect(history, [(role: 'event', text: '已应用赛季计划调整')]);
  });

  test('proposal abandonment is recorded on the originating session', () async {
    await api.abandonCoachProposal(
      sessionId: 'qa-2026-07-19',
      target: const {'kind': 'master', 'plan_id': 'plan-1'},
      summary: '暂不调整',
    );

    expect(recorder.lastRequest?.data, {
      'session_id': 'qa-2026-07-19',
      'target': {'kind': 'master', 'plan_id': 'plan-1'},
      'summary': '暂不调整',
    });
  });
}
