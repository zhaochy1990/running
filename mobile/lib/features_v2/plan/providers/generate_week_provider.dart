/// Provider for D1 单周生成 (T27).
///
/// Manages the async state machine for `POST /api/{user}/plan/weeks/generate`.
/// States: idle → generating → success(folder) | conflict | error(message).
library;

import 'package:flutter/foundation.dart' show protected;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../core/api/api_exception.dart';
import '../../../data/api/stride_api.dart';

// ── State ─────────────────────────────────────────────────────────────────────

sealed class GenerateWeekState {
  const GenerateWeekState();
}

class GenerateWeekIdle extends GenerateWeekState {
  const GenerateWeekIdle();
}

class GenerateWeekGenerating extends GenerateWeekState {
  const GenerateWeekGenerating();
}

class GenerateWeekSuccess extends GenerateWeekState {
  const GenerateWeekSuccess({required this.folder});
  final String folder;
}

/// 409 conflict — the week already exists. Caller shows override dialog.
class GenerateWeekConflict extends GenerateWeekState {
  const GenerateWeekConflict();
}

class GenerateWeekError extends GenerateWeekState {
  const GenerateWeekError({required this.message});
  final String message;
}

// ── Notifier ──────────────────────────────────────────────────────────────────

class GenerateWeekNotifier extends StateNotifier<GenerateWeekState> {
  GenerateWeekNotifier(this._api, this._userId)
      : super(const GenerateWeekIdle());

  /// Protected constructor for subclasses (e.g. test fakes) that want to
  /// start with a specific [initialState] without needing real dependencies.
  @protected
  GenerateWeekNotifier.withState(GenerateWeekState initialState)
      : _api = null,
        _userId = '',
        super(initialState);

  final StrideApi? _api;
  final String _userId;

  /// Trigger generation. When [force] is true the 409 conflict is overridden.
  Future<void> generate(String weekStart, {bool force = false}) async {
    state = const GenerateWeekGenerating();
    try {
      final result = await _api!.generateWeek(
        _userId,
        weekStart: weekStart,
        source: 'manual',
        force: force,
      );
      state = GenerateWeekSuccess(folder: result.folder);
    } on ApiException catch (e) {
      if (e.isConflict) {
        state = const GenerateWeekConflict();
      } else {
        state = GenerateWeekError(message: e.message);
      }
    } catch (e) {
      state = GenerateWeekError(message: e.toString());
    }
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

final generateWeekProvider =
    StateNotifierProvider.autoDispose<GenerateWeekNotifier, GenerateWeekState>(
  (ref) {
    final api = ref.watch(strideApiProvider);
    final userId = ref.watch(currentUserIdProvider);
    if (userId == null) throw Exception('用户未登录');
    return GenerateWeekNotifier(api, userId);
  },
);
