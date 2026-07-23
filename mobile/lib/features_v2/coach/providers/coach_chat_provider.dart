import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/coach_turn_id.dart';
import '../../../data/api/stride_api.dart';

/// A single chat message in the 教练 (S3 daily Q&A) transcript.
class CoachMessage {
  const CoachMessage({required this.role, required this.text});
  final String role; // 'user' | 'assistant' | 'event'
  final String text;

  bool get isUser => role == 'user';
  bool get isEvent => role == 'event';
}

/// A stateless season-plan proposal returned by the Coach orchestrator.
/// The complete raw diff is retained so the selected proposal can be sent
/// unchanged to the apply endpoint.
class CoachProposal {
  const CoachProposal({
    required this.specialistId,
    required this.proposal,
    required this.baseRevision,
  });

  final String specialistId;
  final Map<String, dynamic> proposal;
  final String baseRevision;

  String get diffId => proposal['diff_id'] as String? ?? '';
  String get planId => proposal['plan_id'] as String? ?? '';
  String get explanation => proposal['ai_explanation'] as String? ?? '训练计划调整方案';
  List<Map<String, dynamic>> get ops {
    final result = <Map<String, dynamic>>[];
    for (final item in (proposal['ops'] as List? ?? const [])) {
      if (item is Map<String, dynamic>) result.add(item);
    }
    return result;
  }

  static CoachProposal? fromCard(Map<String, dynamic> card) {
    final specialistId = card['specialist_id'] as String? ?? '';
    final rawProposal = card['proposal'];
    if (specialistId != 'season_plan' || rawProposal is! Map<String, dynamic>) {
      return null;
    }
    return CoachProposal(
      specialistId: specialistId,
      proposal: rawProposal,
      baseRevision: card['base_revision'] as String? ?? '',
    );
  }
}

class CoachChatState {
  const CoachChatState({
    this.messages = const [],
    this.loading = false,
    this.threadId,
    this.error,
    this.proposals = const [],
    this.selectedProposalId,
    this.applying = false,
  });

  final List<CoachMessage> messages;
  final bool loading;
  final String? threadId;
  final String? error;
  final List<CoachProposal> proposals;
  final String? selectedProposalId;
  final bool applying;

  CoachChatState copyWith({
    List<CoachMessage>? messages,
    bool? loading,
    String? threadId,
    String? error,
    bool clearError = false,
    List<CoachProposal>? proposals,
    String? Function()? selectedProposalId,
    bool? applying,
  }) {
    return CoachChatState(
      messages: messages ?? this.messages,
      loading: loading ?? this.loading,
      threadId: threadId ?? this.threadId,
      error: clearError ? null : (error ?? this.error),
      proposals: proposals ?? this.proposals,
      selectedProposalId: selectedProposalId != null
          ? selectedProposalId()
          : this.selectedProposalId,
      applying: applying ?? this.applying,
    );
  }
}

class CoachChatNotifier extends StateNotifier<CoachChatState> {
  CoachChatNotifier(
    this._api, {
    String? sessionId,
    String Function()? clientTurnIdFactory,
  }) : _sessionId = sessionId ?? _todaySessionId(),
       _clientTurnIdFactory = clientTurnIdFactory ?? createCoachClientTurnId,
       super(const CoachChatState());

  final StrideApi _api;
  final String _sessionId;
  final String Function() _clientTurnIdFactory;
  String? _pendingMessage;
  String? _pendingClientTurnId;

  Future<void> sendMessage(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty || state.loading || state.applying) return;

    final isRetry = _pendingMessage == trimmed && _pendingClientTurnId != null;
    final clientTurnId = isRetry
        ? _pendingClientTurnId!
        : _clientTurnIdFactory();
    _pendingMessage = trimmed;
    _pendingClientTurnId = clientTurnId;

    state = state.copyWith(
      messages: isRetry
          ? state.messages
          : [...state.messages, CoachMessage(role: 'user', text: trimmed)],
      loading: true,
      clearError: true,
      proposals: const [],
      selectedProposalId: () => null,
    );

    try {
      final res = await _api.postCoachChat(
        sessionId: _sessionId,
        message: trimmed,
        clientTurnId: clientTurnId,
      );
      // Prefer the orchestrated reply; fall back to a clarify-turn question.
      final replyText = res.reply.trim().isNotEmpty
          ? res.reply
          : (res.clarification?.trim().isNotEmpty == true
                ? res.clarification!
                : '（教练没有返回内容）');
      final proposals = <CoachProposal>[];
      for (final card in res.proposals) {
        final proposal = CoachProposal.fromCard(card);
        if (proposal != null) proposals.add(proposal);
      }
      _pendingMessage = null;
      _pendingClientTurnId = null;
      state = state.copyWith(
        messages: [
          ...state.messages,
          CoachMessage(role: 'assistant', text: replyText),
        ],
        loading: false,
        threadId: res.threadId,
        proposals: proposals,
        selectedProposalId: () =>
            proposals.isEmpty ? null : proposals.first.diffId,
      );
    } catch (e) {
      state = state.copyWith(loading: false, error: e.toString());
    }
  }

  Future<List<CoachMessage>> _readTrustedHistory() async {
    final threadId = state.threadId;
    if (threadId == null || threadId.isEmpty) return state.messages;
    try {
      final history = await _api.getCoachThread(threadId);
      return history
          .map(
            (message) => CoachMessage(role: message.role, text: message.text),
          )
          .toList(growable: false);
    } catch (_) {
      // The apply/abandon write already succeeded. A transient history read
      // failure must not leave the proposal actionable for a duplicate retry.
      return state.messages;
    }
  }

  void selectProposal(String diffId) {
    if (state.applying ||
        !state.proposals.any((proposal) => proposal.diffId == diffId)) {
      return;
    }
    state = state.copyWith(selectedProposalId: () => diffId);
  }

  CoachProposal? _selectedProposal() {
    final selectedId = state.selectedProposalId;
    if (selectedId == null) return null;
    for (final proposal in state.proposals) {
      if (proposal.diffId == selectedId) return proposal;
    }
    return null;
  }

  Future<void> dismissProposals() async {
    if (state.applying) return;
    final selected =
        _selectedProposal() ??
        (state.proposals.isEmpty ? null : state.proposals.first);
    if (selected == null || selected.planId.isEmpty) {
      state = state.copyWith(
        proposals: const [],
        selectedProposalId: () => null,
      );
      return;
    }

    state = state.copyWith(applying: true, clearError: true);
    try {
      await _api.abandonCoachProposal(
        sessionId: _sessionId,
        target: {'kind': 'master', 'plan_id': selected.planId},
        summary: '用户放弃了本次调整方案',
      );
      final messages = await _readTrustedHistory();
      state = state.copyWith(
        messages: messages,
        proposals: const [],
        selectedProposalId: () => null,
        applying: false,
      );
    } catch (e) {
      state = state.copyWith(applying: false, error: e.toString());
    }
  }

  Future<void> applySelectedProposal() async {
    if (state.applying) return;
    final selected = _selectedProposal();
    if (selected == null ||
        selected.planId.isEmpty ||
        selected.baseRevision.isEmpty) {
      return;
    }
    final opIds = selected.ops
        .where((op) => op['accepted'] != false)
        .map((op) => op['id'] as String? ?? '')
        .where((id) => id.isNotEmpty)
        .toList(growable: false);
    if (opIds.isEmpty) return;

    state = state.copyWith(applying: true, clearError: true);
    try {
      await _api.applyCoachMasterPlanDiff(
        sessionId: _sessionId,
        planId: selected.planId,
        diff: selected.proposal,
        acceptedOpIds: opIds,
        baseRevision: selected.baseRevision,
      );
      final messages = await _readTrustedHistory();
      state = state.copyWith(
        messages: messages,
        proposals: const [],
        selectedProposalId: () => null,
        applying: false,
      );
    } catch (e) {
      state = state.copyWith(applying: false, error: e.toString());
    }
  }

  static String _todaySessionId() {
    final now = DateTime.now();
    String two(int v) => v.toString().padLeft(2, '0');
    return 'qa-${now.year}-${two(now.month)}-${two(now.day)}';
  }
}

final coachChatProvider =
    StateNotifierProvider.autoDispose<CoachChatNotifier, CoachChatState>(
      (ref) => CoachChatNotifier(ref.watch(strideApiProvider)),
    );
