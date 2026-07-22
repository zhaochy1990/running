import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/_shared/sync/sync_controller.dart';
import 'package:stride/features_v2/activity/models/activity_detail.dart';
import 'package:stride/features_v2/activity/models/timeseries_data.dart';
import 'package:stride/features_v2/activity/providers/activity_detail_provider.dart';
import 'package:stride/features_v2/activity/providers/timeseries_provider.dart';
import 'package:stride/features_v2/review/models/week_review.dart';
import 'package:stride/features_v2/review/providers/week_review_provider.dart';

class _StubApi extends StrideApi {
  _StubApi() : super(Dio());

  int calls = 0;
  final syncedUsers = <String>[];
  int activityDetailCalls = 0;
  int timeseriesCalls = 0;
  int weekReviewCalls = 0;
  Completer<void> _completer = Completer<void>();

  void resolveOk() {
    _completer.complete();
    _completer = Completer<void>();
  }

  void resolveError(Object e) {
    _completer.completeError(e);
    _completer = Completer<void>();
  }

  @override
  Future<void> triggerSync(String user, {bool full = false}) async {
    calls++;
    syncedUsers.add(user);
    await _completer.future;
  }

  @override
  Future<ActivityDetailV2> getActivityDetail(
    String user,
    String labelId, {
    bool includeTimeseries = false,
  }) async {
    activityDetailCalls++;
    return ActivityDetailV2.fromJson({
      'activity': {'label_id': labelId},
    });
  }

  @override
  Future<TimeseriesData> getActivityTimeseries(
    String user,
    String labelId, {
    int downsample = 300,
    Set<String>? fields,
  }) async {
    timeseriesCalls++;
    return TimeseriesData.fromJson({'label_id': labelId});
  }

  @override
  Future<WeekReview> getWeekReview(String user, String folder) async {
    weekReviewCalls++;
    return WeekReview.fromJson({
      'folder': folder,
      'date_from': '2026-07-13',
      'date_to': '2026-07-19',
      'summary': <String, dynamic>{},
    });
  }
}

ProviderContainer _container(_StubApi api) {
  return ProviderContainer(
    overrides: [
      strideApiProvider.overrideWithValue(api),
      currentUserIdProvider.overrideWithValue('user-001'),
    ],
  );
}

void main() {
  test(
    'initial state is idle (syncing=false, lastSyncedAt=null, error=null)',
    () {
      final api = _StubApi();
      final c = _container(api);
      addTearDown(c.dispose);
      final state = c.read(syncControllerProvider);
      expect(state.syncing, isFalse);
      expect(state.lastSyncedAt, isNull);
      expect(state.error, isNull);
    },
  );

  test('missing current user fails instead of reporting success', () async {
    final api = _StubApi();
    final c = ProviderContainer(
      overrides: [
        strideApiProvider.overrideWithValue(api),
        currentUserIdProvider.overrideWithValue(null),
      ],
    );
    addTearDown(c.dispose);

    await expectLater(
      c.read(syncControllerProvider.notifier).triggerSync(),
      throwsA(isA<StateError>()),
    );
    expect(api.calls, 0);
  });

  test('syncing flag flips true during, false after', () async {
    final api = _StubApi();
    final c = _container(api);
    addTearDown(c.dispose);

    final notifier = c.read(syncControllerProvider.notifier);
    final fut = notifier.triggerSync();

    await Future<void>.delayed(Duration.zero);
    expect(c.read(syncControllerProvider).syncing, isTrue);

    api.resolveOk();
    await fut;
    expect(c.read(syncControllerProvider).syncing, isFalse);
  });

  test('successful sync sets lastSyncedAt and clears error', () async {
    final api = _StubApi();
    final c = _container(api);
    addTearDown(c.dispose);

    final notifier = c.read(syncControllerProvider.notifier);
    final fut = notifier.triggerSync();
    api.resolveOk();
    await fut;

    final state = c.read(syncControllerProvider);
    expect(state.syncing, isFalse);
    expect(state.lastSyncedAt, isNotNull);
    expect(state.error, isNull);
  });

  test('failed sync sets error and preserves prior lastSyncedAt', () async {
    final api = _StubApi();
    final c = _container(api);
    addTearDown(c.dispose);

    final notifier = c.read(syncControllerProvider.notifier);

    final ok = notifier.triggerSync();
    api.resolveOk();
    await ok;
    final priorTimestamp = c.read(syncControllerProvider).lastSyncedAt;
    expect(priorTimestamp, isNotNull);

    final bad = notifier.triggerSync();
    api.resolveError(Exception('boom'));
    await expectLater(bad, throwsA(isA<Exception>()));

    final state = c.read(syncControllerProvider);
    expect(state.syncing, isFalse);
    expect(state.error, isA<Exception>());
    expect(state.lastSyncedAt, equals(priorTimestamp));
  });

  test('successful sync refreshes active watch-derived views', () async {
    final api = _StubApi();
    final c = _container(api);
    addTearDown(c.dispose);

    const activityId = 'activity-001';
    const seriesParams = (id: activityId, fields: 'hr');
    const folder = '2026-07-13_07-19';
    final subscriptions = [
      c.listen(
        activityDetailProvider(activityId),
        (_, _) {},
        fireImmediately: true,
      ),
      c.listen(
        timeseriesProvider(seriesParams),
        (_, _) {},
        fireImmediately: true,
      ),
      c.listen(weekReviewProvider(folder), (_, _) {}, fireImmediately: true),
    ];
    addTearDown(() {
      for (final subscription in subscriptions) {
        subscription.close();
      }
    });

    await Future.wait([
      c.read(activityDetailProvider(activityId).future),
      c.read(timeseriesProvider(seriesParams).future),
      c.read(weekReviewProvider(folder).future),
    ]);
    expect(
      (api.activityDetailCalls, api.timeseriesCalls, api.weekReviewCalls),
      (1, 1, 1),
    );

    final sync = c.read(syncControllerProvider.notifier).triggerSync();
    api.resolveOk();
    await sync;
    await Future.wait([
      c.read(activityDetailProvider(activityId).future),
      c.read(timeseriesProvider(seriesParams).future),
      c.read(weekReviewProvider(folder).future),
    ]);

    expect(
      (api.activityDetailCalls, api.timeseriesCalls, api.weekReviewCalls),
      (2, 2, 2),
    );
  });

  test('failed sync does not refresh active watch-derived views', () async {
    final api = _StubApi();
    final c = _container(api);
    addTearDown(c.dispose);

    const activityId = 'activity-001';
    final subscription = c.listen(
      activityDetailProvider(activityId),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);
    await c.read(activityDetailProvider(activityId).future);

    final sync = c.read(syncControllerProvider.notifier).triggerSync();
    api.resolveError(Exception('boom'));
    await expectLater(sync, throwsA(isA<Exception>()));
    await Future<void>.delayed(Duration.zero);

    expect(api.activityDetailCalls, 1);
  });

  test('re-entry awaits the in-flight sync', () async {
    final api = _StubApi();
    final c = _container(api);
    addTearDown(c.dispose);

    final notifier = c.read(syncControllerProvider.notifier);
    final first = notifier.triggerSync();
    await Future<void>.delayed(Duration.zero);
    var secondCompleted = false;
    final second = notifier.triggerSync().then((_) => secondCompleted = true);

    await Future<void>.delayed(Duration.zero);
    expect(secondCompleted, isFalse);
    expect(
      api.calls,
      1,
      reason: 'second call must reuse the in-flight request',
    );

    api.resolveOk();
    await Future.wait([first, second]);
    expect(secondCompleted, isTrue);
  });

  test('another user cannot reuse the in-flight sync result', () async {
    final api = _StubApi();
    final userIdProvider = StateProvider<String?>((_) => 'user-001');
    final c = ProviderContainer(
      overrides: [
        strideApiProvider.overrideWithValue(api),
        currentUserIdProvider.overrideWith((ref) => ref.watch(userIdProvider)),
      ],
    );
    addTearDown(c.dispose);

    final notifier = c.read(syncControllerProvider.notifier);
    final first = notifier.triggerSync();
    await Future<void>.delayed(Duration.zero);
    c.read(userIdProvider.notifier).state = 'user-002';

    await expectLater(notifier.triggerSync(), throwsA(isA<StateError>()));
    expect(api.syncedUsers, ['user-001']);

    api.resolveOk();
    await expectLater(first, throwsA(isA<StateError>()));
  });

  test('re-entry observes the in-flight sync failure', () async {
    final api = _StubApi();
    final c = _container(api);
    addTearDown(c.dispose);

    final notifier = c.read(syncControllerProvider.notifier);
    final first = notifier.triggerSync();
    await Future<void>.delayed(Duration.zero);
    final second = notifier.triggerSync();
    final firstResult = expectLater(first, throwsA(isA<Exception>()));
    final secondResult = expectLater(second, throwsA(isA<Exception>()));

    api.resolveError(Exception('boom'));
    await Future.wait([firstResult, secondResult]);

    expect(api.calls, 1);
  });
}
