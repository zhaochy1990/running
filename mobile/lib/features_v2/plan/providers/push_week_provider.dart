/// pushWeekProvider — StateNotifier managing the D2b week-push flow.
///
/// State machine:
///   idle → loading → result (success/partial/failed)
///
/// Iterates over all pushable sessions in the week and calls the
/// per-session push endpoint sequentially, collecting results.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../../../data/models/weekly_plan.dart';
import 'week_detail_provider.dart';

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
  const PushWeekResult({required this.results});

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

  /// Push all pushable sessions of [days] to the watch.
  Future<void> pushWeek({
    required String folder,
    required List<WeekDaySessions> days,
  }) async {
    state = const PushWeekLoading();

    try {
      final api = _ref.read(strideApiProvider);
      final userId = _ref.read(currentUserIdProvider);
      if (userId == null) {
        state = const PushWeekError('用户未登录');
        return;
      }

      final results = <SessionPushResult>[];
      for (final day in days) {
        for (final session in day.sessions) {
          if (!session.pushable) continue; // rest days etc.
          final name = session.displayName ?? kindLabel(session.kind);
          try {
            await api.pushPlannedSession(
              userId,
              day.date,
              session.sessionIndex,
            );
            results.add(SessionPushResult(
              date: day.date,
              sessionIndex: session.sessionIndex,
              sessionName: name,
              success: true,
            ));
          } catch (e) {
            results.add(SessionPushResult(
              date: day.date,
              sessionIndex: session.sessionIndex,
              sessionName: name,
              success: false,
              errorMessage: e.toString(),
            ));
          }
        }
      }

      state = PushWeekDone(PushWeekResult(results: results));
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

    try {
      await api.pushPlannedSession(
        userId,
        failed.date,
        failed.sessionIndex,
      );

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
}

final pushWeekProvider =
    StateNotifierProvider.autoDispose<PushWeekNotifier, PushWeekState>(
  (ref) => PushWeekNotifier(ref),
);
