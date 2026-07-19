/// Riverpod state for D4 plan chat screen (T32).
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/coach_turn_id.dart';
import '../../../data/api/stride_api.dart';
import '../models/plan_chat.dart';

// ── State ─────────────────────────────────────────────────────────────────────

class PlanChatState {
  const PlanChatState({
    this.messages = const [],
    this.pendingDiff,
    this.baseRevision = '',
    this.acceptedOpIds = const {},
    this.loading = false,
    this.error,
  });

  final List<ChatMessage> messages;
  final PlanDiffView? pendingDiff;
  final String baseRevision;
  final Set<String> acceptedOpIds;
  final bool loading;
  final String? error;

  bool get hasPendingAccepted =>
      pendingDiff != null &&
      acceptedOpIds.isNotEmpty &&
      baseRevision.isNotEmpty;

  PlanChatState copyWith({
    List<ChatMessage>? messages,
    PlanDiffView? Function()? pendingDiff,
    String? baseRevision,
    Set<String>? acceptedOpIds,
    bool? loading,
    String? Function()? error,
  }) => PlanChatState(
    messages: messages ?? this.messages,
    pendingDiff: pendingDiff != null ? pendingDiff() : this.pendingDiff,
    baseRevision: baseRevision ?? this.baseRevision,
    acceptedOpIds: acceptedOpIds ?? this.acceptedOpIds,
    loading: loading ?? this.loading,
    error: error != null ? error() : this.error,
  );
}

// ── Notifier ──────────────────────────────────────────────────────────────────

class PlanChatNotifier extends StateNotifier<PlanChatState> {
  // The second positional arg (legacy user id) is unused now that the
  // orchestrator endpoints are scoped to `/api/users/me/...`; kept so existing
  // call sites / tests (`super(null, null)`) compile unchanged. The optional
  // factory is a test seam for deterministic idempotency keys.
  PlanChatNotifier(
    this._api, [
    String? _,
    String Function()? clientTurnIdFactory,
  ]) : _clientTurnIdFactory = clientTurnIdFactory ?? createCoachClientTurnId,
       super(const PlanChatState());

  final StrideApi? _api;
  final String Function() _clientTurnIdFactory;
  String? _pendingMessage;
  String? _pendingClientTurnId;

  /// Send a user message through the orchestrator coach and receive the AI
  /// reply + optional `weekly_plan` diff proposal.
  Future<void> sendMessage(String folder, String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty || state.loading) return;

    final isRetry = _pendingMessage == trimmed && _pendingClientTurnId != null;
    final clientTurnId = isRetry
        ? _pendingClientTurnId!
        : _clientTurnIdFactory();
    _pendingMessage = trimmed;
    _pendingClientTurnId = clientTurnId;

    state = state.copyWith(
      messages: isRetry
          ? state.messages
          : [...state.messages, ChatMessage(role: 'user', content: trimmed)],
      loading: true,
      error: () => null,
      pendingDiff: () => null,
      baseRevision: '',
      acceptedOpIds: const {},
    );

    try {
      final resp = await _api!.sendWeeklyAdjustMessage(
        folder: folder,
        message: trimmed,
        clientTurnId: clientTurnId,
      );

      final aiText = resp.reply.isNotEmpty
          ? resp.reply
          : (resp.clarification ?? '');
      final aiMsg = ChatMessage(role: 'assistant', content: aiText);

      PlanDiffView? diff;
      final rawDiff = resp.diff;
      if (rawDiff != null) {
        diff = PlanDiffView.fromJson(rawDiff);
      }
      final applicableOpIds =
          diff?.ops
              .where((op) => op.accepted != false)
              .map((op) => op.id)
              .toSet() ??
          const <String>{};

      _pendingMessage = null;
      _pendingClientTurnId = null;
      state = state.copyWith(
        messages: [...state.messages, aiMsg],
        pendingDiff: () => diff,
        baseRevision: resp.baseRevision,
        acceptedOpIds: applicableOpIds,
        loading: false,
      );
    } catch (e) {
      state = state.copyWith(loading: false, error: () => e.toString());
    }
  }

  /// Weekly proposals are enabled as one unit; partial toggles are not allowed.
  void toggleOp(String opId) {}

  /// Apply every applicable op to the backend as one stateless proposal.
  Future<void> applyDiff(String folder) async {
    final diff = state.pendingDiff;
    if (diff == null ||
        state.acceptedOpIds.isEmpty ||
        state.baseRevision.isEmpty) {
      return;
    }

    state = state.copyWith(loading: true, error: () => null);
    try {
      await _api!.applyWeeklyAdjustDiff(
        folder: folder,
        diff: diff.toJson(),
        acceptedOpIds: state.acceptedOpIds.toList(growable: false),
        baseRevision: state.baseRevision,
      );
      state = state.copyWith(
        pendingDiff: () => null,
        baseRevision: '',
        acceptedOpIds: const {},
        loading: false,
      );
    } catch (e) {
      state = state.copyWith(loading: false, error: () => e.toString());
    }
  }

  /// Reset to initial state.
  void reset() {
    _pendingMessage = null;
    _pendingClientTurnId = null;
    state = const PlanChatState();
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

final planChatProvider =
    StateNotifierProvider.family<PlanChatNotifier, PlanChatState, String>((
      ref,
      folder,
    ) {
      final api = ref.watch(strideApiProvider);
      final userId = ref.watch(currentUserIdProvider);
      return PlanChatNotifier(api, userId);
    });
