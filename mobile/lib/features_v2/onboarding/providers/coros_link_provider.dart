import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';

/// State for the B2 COROS-link screen.
///
/// Surface-level transitions:
///   - initial      -> idle, no error
///   - loading      -> request in flight, submit button disabled
///   - error(msg)   -> show inline error, allow retry
///   - success      -> route forward to B3
class CorosLinkState {
  const CorosLinkState({
    this.loading = false,
    this.error,
    this.success = false,
  });

  final bool loading;
  final String? error;
  final bool success;

  CorosLinkState copyWith({bool? loading, String? error, bool? success}) {
    return CorosLinkState(
      loading: loading ?? this.loading,
      error: error,
      success: success ?? this.success,
    );
  }

  static const initial = CorosLinkState();
}

class CorosLinkController extends StateNotifier<CorosLinkState> {
  CorosLinkController(this._ref) : super(CorosLinkState.initial);

  final Ref _ref;

  Future<void> bind({
    required String email,
    required String password,
    required String region,
  }) async {
    state = const CorosLinkState(loading: true);
    try {
      await _ref
          .read(strideApiProvider)
          .linkCoros(email: email, password: password, region: region);
      // Refresh profile so the router guard sees coros_ready=true.
      _ref.invalidate(currentUserProvider);
      state = const CorosLinkState(success: true);
    } on ApiException catch (e) {
      state = CorosLinkState(error: _mapError(e));
    } catch (_) {
      state = const CorosLinkState(error: '网络异常，请检查网络后重试');
    }
  }

  void clearError() {
    if (state.error != null) {
      state = state.copyWith(error: null);
    }
  }

  String _mapError(ApiException e) {
    final raw = (e.detail is Map && (e.detail as Map)['detail'] != null)
        ? (e.detail as Map)['detail'].toString()
        : e.message;
    final lower = raw.toLowerCase();
    if (e.statusCode == 401 || e.statusCode == 400) {
      // Backend collapses auth/network errors to 400 — heuristic match
      // against the message for the region-mismatch case.
      if (lower.contains('region') ||
          raw.contains('区域') ||
          raw.contains('地区')) {
        return '请切换区域后重试';
      }
      return '邮箱或密码错误，请核对 COROS 账号';
    }
    if (e.isServerError) return '服务端异常，请稍后重试';
    return raw.isEmpty ? '绑定失败，请重试' : raw;
  }
}

final corosLinkProvider =
    StateNotifierProvider.autoDispose<CorosLinkController, CorosLinkState>(
      (ref) => CorosLinkController(ref),
    );
