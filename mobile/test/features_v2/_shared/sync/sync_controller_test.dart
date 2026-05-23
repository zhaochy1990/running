import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/_shared/sync/sync_controller.dart';

class _StubApi extends StrideApi {
  _StubApi() : super(Dio());

  int calls = 0;
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
    await _completer.future;
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
  test('initial state is idle (syncing=false, lastSyncedAt=null, error=null)', () {
    final api = _StubApi();
    final c = _container(api);
    addTearDown(c.dispose);
    final state = c.read(syncControllerProvider);
    expect(state.syncing, isFalse);
    expect(state.lastSyncedAt, isNull);
    expect(state.error, isNull);
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

  test('re-entry while syncing is a no-op', () async {
    final api = _StubApi();
    final c = _container(api);
    addTearDown(c.dispose);

    final notifier = c.read(syncControllerProvider.notifier);
    final first = notifier.triggerSync();
    await Future<void>.delayed(Duration.zero);
    final second = notifier.triggerSync();

    api.resolveOk();
    await Future.wait([first, second]);

    expect(api.calls, 1, reason: 'second call must be guarded out');
  });
}
