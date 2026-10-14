import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/api/api_exception.dart';
import 'package:stride/data/api/stride_api.dart';

Dio _dioWithResponse(
  Map<String, dynamic> body, {
  void Function(RequestOptions options)? inspectRequest,
  int statusCode = 200,
}) {
  final dio = Dio(BaseOptions(receiveTimeout: const Duration(seconds: 30)));
  dio.interceptors.add(
    InterceptorsWrapper(
      onRequest: (options, handler) {
        inspectRequest?.call(options);
        handler.resolve(
          Response<Map<String, dynamic>>(
            requestOptions: options,
            statusCode: statusCode,
            data: body,
          ),
        );
      },
    ),
  );
  return dio;
}

void main() {
  group('StrideApi.triggerSync — Go 契约（#418 端点表）', () {
    test(
      'sends body {mode} + Idempotency-Key header; five-minute receive timeout only for sync',
      () async {
        late RequestOptions request;
        final dio = _dioWithResponse({
          'run_id': 'run-1',
          'pipeline_name': 'onboarding',
        }, inspectRequest: (options) => request = options);
        final api = StrideApi(dio);

        final res = await api.triggerSync(
          'user-001',
          full: true,
          idempotencyKey: 'app-onboarding-user-001-1-abc',
        );

        expect(request.path, '/api/user-001/sync');
        expect(request.data, {'mode': 'full'});
        expect(
          request.headers['Idempotency-Key'],
          'app-onboarding-user-001-1-abc',
        );
        expect(request.receiveTimeout, const Duration(minutes: 5));
        expect(dio.options.receiveTimeout, const Duration(seconds: 30));
        expect(res.runId, 'run-1');
        expect(res.deduplicated, isFalse);
      },
    );

    test('incremental mode body when full=false', () async {
      late RequestOptions request;
      final dio = _dioWithResponse({
        'run_id': 'run-2',
        'pipeline_name': 'watch_sync',
      }, inspectRequest: (options) => request = options);
      await StrideApi(dio).triggerSync('user-001', full: false);
      expect(request.data, {'mode': 'incremental'});
      expect(request.headers['Idempotency-Key'], isNull);
    });

    test('parses deduplicated=true envelope', () async {
      final api = StrideApi(
        _dioWithResponse({
          'run_id': 'run-existing',
          'pipeline_name': 'onboarding',
          'deduplicated': true,
        }),
      );
      final res = await api.triggerSync('user-001', full: true);
      expect(res.runId, 'run-existing');
      expect(res.deduplicated, isTrue);
    });

    test('rejects a response without run_id（对 Go 必不再断言 success 字段）', () async {
      final api = StrideApi(_dioWithResponse({'success': true}));

      await expectLater(
        api.triggerSync('user-001', full: true),
        throwsA(
          isA<ApiException>()
              .having((e) => e.statusCode, 'statusCode', 200)
              .having((e) => e.message, 'message', 'Invalid sync response'),
        ),
      );
    });
  });

  group('StrideApi pipelines — run shape（六步 shape 钉住）', () {
    test('getPipelineRun parses the onboarding run payload', () async {
      late RequestOptions request;
      final dio = _dioWithResponse({
        'run_id': 'run-9',
        'user_id': 'user-001',
        'pipeline_name': 'onboarding',
        'status': 'running',
        'current_step': 2,
        'steps': [
          {'name': 'sync', 'job_type': 'watch_sync', 'status': 'done'},
          {
            'name': 'race_detection',
            'job_type': 'race_detection',
            'status': 'done',
          },
          {
            'name': 'calibration',
            'job_type': 'calibration',
            'status': 'running',
          },
          {'name': 'compute', 'job_type': 'compute', 'status': 'queued'},
          {
            'name': 'route_thumbnails',
            'job_type': 'route_thumbnails',
            'status': 'queued',
            'continue_on_failure': true,
          },
          {
            'name': 'ability',
            'job_type': 'ability',
            'status': 'queued',
            'continue_on_failure': true,
          },
        ],
      }, inspectRequest: (options) => request = options);
      final run = await StrideApi(dio).getPipelineRun('run-9');

      expect(request.path, '/api/pipelines/run-9');
      expect(run.pipelineName, 'onboarding');
      expect(run.status, 'running');
      expect(run.currentStep, 2);
      expect(run.steps.length, 6);
      expect(run.steps.map((s) => s.name).toList(), [
        'sync',
        'race_detection',
        'calibration',
        'compute',
        'route_thumbnails',
        'ability',
      ]);
      expect(run.errorMessage, isNull);
    });

    test('getPipelineRun surfaces error_message on failed runs', () async {
      final dio = _dioWithResponse({
        'run_id': 'run-10',
        'pipeline_name': 'onboarding',
        'status': 'failed',
        'current_step': 0,
        'steps': [
          {'name': 'sync', 'job_type': 'watch_sync', 'status': 'failed'},
        ],
        'error_message': 'watch login failed',
      });
      final run = await StrideApi(dio).getPipelineRun('run-10');
      expect(run.isFailed, isTrue);
      expect(run.errorMessage, 'watch login failed');
    });

    test('listUserPipelines unwraps {pipelines: [...]}', () async {
      late RequestOptions request;
      final dio = _dioWithResponse({
        'pipelines': [
          {
            'run_id': 'run-new',
            'pipeline_name': 'onboarding',
            'status': 'running',
            'current_step': 0,
            'steps': <Map<String, dynamic>>[],
          },
          {
            'run_id': 'run-old',
            'pipeline_name': 'watch_sync',
            'status': 'done',
            'current_step': 1,
            'steps': <Map<String, dynamic>>[],
          },
        ],
      }, inspectRequest: (options) => request = options);
      final runs = await StrideApi(dio).listUserPipelines('user-001');

      expect(request.path, '/api/users/user-001/pipelines');
      expect(runs.length, 2);
      expect(runs[0].runId, 'run-new');
      expect(runs[1].pipelineName, 'watch_sync');
    });
  });
}
