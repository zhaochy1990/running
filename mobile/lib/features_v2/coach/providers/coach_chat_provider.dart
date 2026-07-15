import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/stride_api.dart';

/// A single chat message in the 教练 (S3 daily Q&A) transcript.
class CoachMessage {
  const CoachMessage({required this.role, required this.text});
  final String role; // 'user' | 'assistant'
  final String text;

  bool get isUser => role == 'user';
}

/// A stateless season-plan proposal returned by the Coach orchestrator.
/// The complete raw diff is retained so the selected proposal can be sent
/// unchanged to the apply endpoint.
class CoachProposal {
  const CoachProposal({required this.specialistId, required this.proposal});

  final String specialistId;
  final Map<String, dynamic> proposal;

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
    return CoachProposal(specialistId: specialistId, proposal: rawProposal);
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
  CoachChatNotifier(this._api) : super(const CoachChatState());

  final StrideApi _api;

  // Stable per-day conversation thread, mirroring the legacy QA endpoint's
  // user+today thread derivation: reopening 教练 within the same day continues
  // today's conversation. Must match the server's [A-Za-z0-9_-] session_id rule.
  late final String _sessionId = _todaySessionId();

  Future<void> sendMessage(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty || state.loading || state.applying) return;

    state = state.copyWith(
      messages: [
        ...state.messages,
        CoachMessage(role: 'user', text: trimmed),
      ],
      loading: true,
      clearError: true,
      proposals: const [],
      selectedProposalId: () => null,
    );

    try {
      final res = await _api.postCoachChat(
        sessionId: _sessionId,
        message: trimmed,
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

  void selectProposal(String diffId) {
    if (state.applying ||
        !state.proposals.any((proposal) => proposal.diffId == diffId)) {
      return;
    }
    state = state.copyWith(selectedProposalId: () => diffId);
  }

  void dismissProposals() {
    if (state.applying) return;
    state = state.copyWith(proposals: const [], selectedProposalId: () => null);
  }

  Future<void> applySelectedProposal() async {
    if (state.applying || state.selectedProposalId == null) return;
    CoachProposal? selected;
    for (final proposal in state.proposals) {
      if (proposal.diffId == state.selectedProposalId) {
        selected = proposal;
        break;
      }
    }
    if (selected == null || selected.planId.isEmpty) return;
    final opIds = selected.ops
        .map((op) => op['id'] as String? ?? '')
        .where((id) => id.isNotEmpty)
        .toList();
    if (opIds.isEmpty) return;

    state = state.copyWith(applying: true, clearError: true);
    try {
      final result = await _api.applyCoachMasterPlanDiff(
        planId: selected.planId,
        diff: selected.proposal,
        acceptedOpIds: opIds,
      );
      final version = result['version'];
      final suffix = version == null ? '' : '至 v$version';
      state = state.copyWith(
        messages: [
          ...state.messages,
          CoachMessage(role: 'assistant', text: '方案已应用，训练计划已更新$suffix。'),
        ],
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
