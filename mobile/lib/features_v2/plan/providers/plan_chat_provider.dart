/// Riverpod state for D4 plan chat screen (T32).
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/current_user.dart';
import '../../../data/api/stride_api.dart';
import '../models/plan_chat.dart';

// ── State ─────────────────────────────────────────────────────────────────────

class PlanChatState {
  const PlanChatState({
    this.messages = const [],
    this.pendingDiff,
    this.acceptedOpIds = const {},
    this.loading = false,
    this.error,
  });

  final List<ChatMessage> messages;
  final PlanDiffView? pendingDiff;
  final Set<String> acceptedOpIds;
  final bool loading;
  final String? error;

  bool get hasPendingAccepted => acceptedOpIds.isNotEmpty;

  PlanChatState copyWith({
    List<ChatMessage>? messages,
    PlanDiffView? Function()? pendingDiff,
    Set<String>? acceptedOpIds,
    bool? loading,
    String? Function()? error,
  }) =>
      PlanChatState(
        messages: messages ?? this.messages,
        pendingDiff: pendingDiff != null ? pendingDiff() : this.pendingDiff,
        acceptedOpIds: acceptedOpIds ?? this.acceptedOpIds,
        loading: loading ?? this.loading,
        error: error != null ? error() : this.error,
      );
}

// ── Notifier ──────────────────────────────────────────────────────────────────

class PlanChatNotifier extends StateNotifier<PlanChatState> {
  PlanChatNotifier(this._api, this._userId) : super(const PlanChatState());

  final StrideApi? _api;
  final String? _userId;

  /// Send a user message to the backend and receive AI response + optional diff.
  Future<void> sendMessage(String folder, String text) async {
    if (text.trim().isEmpty) return;

    // Optimistically push the user message
    final userMsg = ChatMessage(role: 'user', content: text);
    state = state.copyWith(
      messages: [...state.messages, userMsg],
      loading: true,
      error: () => null,
      pendingDiff: () => null,
      acceptedOpIds: const {},
    );

    try {
      final history = state.messages
          .where((m) => m.role == 'user' || m.role == 'assistant')
          // exclude the user message we just added (it's the current one)
          .take(state.messages.length - 1)
          .map((m) => m.toJson())
          .toList();

      final resp = await _api!.sendPlanChatMessage(
        user: _userId ?? '',
        folder: folder,
        message: text,
        history: history,
      );

      final aiText = resp['ai_response'] as String? ?? '';
      final aiMsg = ChatMessage(role: 'assistant', content: aiText);

      PlanDiffView? diff;
      final rawDiff = resp['diff'];
      if (rawDiff is Map<String, dynamic>) {
        diff = PlanDiffView.fromJson(rawDiff);
      }

      state = state.copyWith(
        messages: [...state.messages, aiMsg],
        pendingDiff: () => diff,
        acceptedOpIds: diff != null ? {} : state.acceptedOpIds,
        loading: false,
      );
    } catch (e) {
      state = state.copyWith(
        loading: false,
        error: () => e.toString(),
      );
    }
  }

  /// Toggle a diff op's acceptance state.
  void toggleOp(String opId) {
    final current = Set<String>.from(state.acceptedOpIds);
    if (current.contains(opId)) {
      current.remove(opId);
    } else {
      current.add(opId);
    }
    state = state.copyWith(acceptedOpIds: current);
  }

  /// Apply the accepted ops to the backend.
  Future<void> applyDiff(String folder) async {
    final diff = state.pendingDiff;
    if (diff == null || state.acceptedOpIds.isEmpty) return;

    state = state.copyWith(loading: true, error: () => null);
    try {
      await _api!.applyPlanChatDiff(
        user: _userId ?? '',
        folder: folder,
        diffId: diff.diffId,
        acceptedOpIds: state.acceptedOpIds.toList(),
      );
      // Clear diff after successful apply
      state = state.copyWith(
        pendingDiff: () => null,
        acceptedOpIds: const {},
        loading: false,
      );
    } catch (e) {
      state = state.copyWith(loading: false, error: () => e.toString());
    }
  }

  /// Reset to initial state.
  void reset() {
    state = const PlanChatState();
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

final planChatProvider = StateNotifierProvider.family<PlanChatNotifier,
    PlanChatState, String>(
  (ref, folder) {
    final api = ref.watch(strideApiProvider);
    final userId = ref.watch(currentUserIdProvider);
    return PlanChatNotifier(api, userId);
  },
);
