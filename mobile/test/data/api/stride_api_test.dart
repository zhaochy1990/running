import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/api/api_exception.dart';
import 'package:stride/data/api/stride_api.dart';

Dio _dioWithResponse(
  Map<String, dynamic> body, {
  void Function(RequestOptions options)? inspectRequest,
}) {
  final dio = Dio(BaseOptions(receiveTimeout: const Duration(seconds: 30)));
  dio.interceptors.add(
    InterceptorsWrapper(
      onRequest: (options, handler) {
        inspectRequest?.call(options);
        handler.resolve(
          Response<Map<String, dynamic>>(
            requestOptions: options,
            statusCode: 200,
            data: body,
          ),
        );
      },
    ),
  );
  return dio;
}

void main() {
  group('StrideApi.triggerSync', () {
    test(
      'uses a five-minute receive timeout only for the sync request',
      () async {
        late RequestOptions request;
        final dio = _dioWithResponse({
          'success': true,
          'output': '同步完成',
        }, inspectRequest: (options) => request = options);
        final api = StrideApi(dio);

        await api.triggerSync('user-001', full: true);

        expect(request.path, '/api/user-001/sync');
        expect(request.queryParameters, {'full': true});
        expect(request.receiveTimeout, const Duration(minutes: 5));
        expect(dio.options.receiveTimeout, const Duration(seconds: 30));
      },
    );

    test(
      'throws the backend error when a 200 response reports failure',
      () async {
        final api = StrideApi(
          _dioWithResponse({'success': false, 'error': '手表账号未登录'}),
        );

        await expectLater(
          api.triggerSync('user-001'),
          throwsA(
            isA<ApiException>()
                .having((e) => e.statusCode, 'statusCode', 200)
                .having((e) => e.message, 'message', '手表账号未登录'),
          ),
        );
      },
    );

    for (final body in [
      <String, dynamic>{},
      <String, dynamic>{'success': 'true'},
      <String, dynamic>{'success': 1},
      <String, dynamic>{'success': null},
    ]) {
      test('rejects a malformed success envelope: $body', () async {
        final api = StrideApi(_dioWithResponse(body));

        await expectLater(
          api.triggerSync('user-001'),
          throwsA(
            isA<ApiException>()
                .having((e) => e.statusCode, 'statusCode', 200)
                .having((e) => e.message, 'message', 'Invalid sync response'),
          ),
        );
      });
    }
  });
}
