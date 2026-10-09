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
}
