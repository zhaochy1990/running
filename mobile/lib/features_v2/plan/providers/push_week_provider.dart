/// pushWeekProvider — StateNotifier managing the D2b week-push flow.
///
/// State machine:
///   idle → loading → result (success/partial/failed)
///
/// T22 整周推送 endpoint (`POST /api/{user}/plan/:folder/push`) is not yet
/// deployed. When T22 is available, flip [_useT22Endpoint] to `true` and
/// add `pushWeek(folder)` to [StrideApi].
///
/// FALLBACK (current): iterate over all sessions in the week and call the
/// per-session push endpoint sequentially, collecting results.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../../../data/models/plan.dart';

// ── Feature flag ──────────────────────────────────────────────────────────────

/// Set to `true` once T22 `POST /api/{user}/plan/:folder/push` is deployed.
const bool _useT22Endpoint = false;

// ── Models ────────────────────────────────────────────────────────────────────

/// Result of pushing a single session to the watch.
class SessionPushResult {
  const SessionPushResult({
    required this.date,
    required this.sessionIndex,
    required this.sessionName,
    this.success = false,
    this.errorMessage,
  });

  final String date;
  final int sessionIndex;
  final String sessionName;
  final bool success;
  final String? errorMessage;

  SessionPushResult copyWith({bool? success, String? errorMessage}) {
    return SessionPushResult(
      date: date,
      sessionIndex: sessionIndex,
      sessionName: sessionName,
      success: success ?? this.success,
      errorMessage: errorMessage ?? this.errorMessage,
    );
  }
}

/// Aggregated result of a week push operation.
class PushWeekResult {
  const PushWeekResult({
    required this.results,
  });

  final List<SessionPushResult> results;

  int get successCount => results.where((r) => r.success).length;
  int get failureCount => results.where((r) => !r.success).length;
  int get total => results.length;

  List<SessionPushResult> get failures =>
      results.where((r) => !r.success).toList();

  List<SessionPushResult> get successes =>
      results.where((r) => r.success).toList();
}

// ── State ─────────────────────────────────────────────────────────────────────

sealed class PushWeekState {
  const PushWeekState();
}

class PushWeekIdle extends PushWeekState {
  const PushWeekIdle();
}

class PushWeekLoading extends PushWeekState {
  const PushWeekLoading();
}

class PushWeekDone extends PushWeekState {
  const PushWeekDone(this.result);
  final PushWeekResult result;
}

class PushWeekError extends PushWeekState {
  const PushWeekError(this.message);
  final String message;
}

// ── Notifier ──────────────────────────────────────────────────────────────────

class PushWeekNotifier extends StateNotifier<PushWeekState> {
  PushWeekNotifier(this._ref) : super(const PushWeekIdle());

  final Ref _ref;

  /// Push all sessions for [folder] to the watch.
  ///
  /// When [_useT22Endpoint] is true, calls the T22 bulk endpoint.
  /// Otherwise falls back to per-session single pushes.
  Future<void> pushWeek({
    required String folder,
    required List<PlanDay> days,
  }) async {
    state = const PushWeekLoading();

    try {
      final api = _ref.read(strideApiProvider);
      final userId = _ref.read(currentUserIdProvider);
      if (userId == null) {
        state = const PushWeekError('用户未登录');
        return;
      }

      PushWeekResult result;

      if (_useT22Endpoint) {
        // ── T22 bulk endpoint (future) ──────────────────────────────────────
        // result = await api.pushWeek(userId, folder);
        // [placeholder — remove this branch comment once T22 lands]
        result = const PushWeekResult(results: []);
      } else {
        // ── Fallback: per-session sequential push ──────────────────────────
        result = await _pushSessionsFallback(api, userId, days);
      }

      state = PushWeekDone(result);
    } catch (e) {
      state = PushWeekError('推送失败：$e');
    }
  }

  /// Retry a single failed session.
  Future<void> retrySession({
    required String userId,
    required SessionPushResult failed,
  }) async {
    final currentState = state;
    if (currentState is! PushWeekDone) return;

    final api = _ref.read(strideApiProvider);

    // Optimistically mark as retrying (replace with loading indicator if
    // needed; for now we just re-trigger and update the result list).
    try {
      await api.pushPlannedSession(userId, failed.date, failed.sessionIndex);

      final updated = currentState.result.results.map((r) {
        if (r.date == failed.date && r.sessionIndex == failed.sessionIndex) {
          return r.copyWith(success: true, errorMessage: null);
        }
        return r;
      }).toList();

      state = PushWeekDone(PushWeekResult(results: updated));
    } catch (e) {
      // Leave failure entry in place — UI will keep the retry button.
      final updated = currentState.result.results.map((r) {
        if (r.date == failed.date && r.sessionIndex == failed.sessionIndex) {
          return r.copyWith(errorMessage: '重试失败：$e');
        }
        return r;
      }).toList();
      state = PushWeekDone(PushWeekResult(results: updated));
    }
  }

  void reset() => state = const PushWeekIdle();

  // ── Private helpers ────────────────────────────────────────────────────────

  Future<PushWeekResult> _pushSessionsFallback(
    StrideApi api,
    String userId,
    List<PlanDay> days,
  ) async {
    final results = <SessionPushResult>[];

    for (final day in days) {
      for (var idx = 0; idx < day.sessions.length; idx++) {
        final session = day.sessions[idx];
        final name = session.title ?? _kindLabel(session.kind);

        if (!session.pushable) {
          // Skip non-pushable sessions silently (rest days, etc.).
          continue;
        }

        try {
          await api.pushPlannedSession(userId, day.date, idx);
          results.add(SessionPushResult(
            date: day.date,
            sessionIndex: idx,
            sessionName: name,
            success: true,
          ));
        } catch (e) {
          results.add(SessionPushResult(
            date: day.date,
            sessionIndex: idx,
            sessionName: name,
            success: false,
            errorMessage: e.toString(),
          ));
        }
      }
    }

    return PushWeekResult(results: results);
  }

  static String _kindLabel(String kind) {
    return switch (kind.toUpperCase()) {
      'E' => '轻松跑',
      'M' => '马配跑',
      'T' => '节奏跑',
      'I' => '间歇跑',
      'R' => '冲刺跑',
      'STRENGTH' => '力量训练',
      'REST' => '休息日',
      _ => '训练课',
    };
  }
}

final pushWeekProvider =
    StateNotifierProvider.autoDispose<PushWeekNotifier, PushWeekState>(
  (ref) => PushWeekNotifier(ref),
);
