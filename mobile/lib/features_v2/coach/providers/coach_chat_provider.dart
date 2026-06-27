import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/stride_api.dart';

/// A single chat message in the 教练 (S3 daily Q&A) transcript.
class CoachMessage {
  const CoachMessage({required this.role, required this.text});
  final String role; // 'user' | 'assistant'
  final String text;

  bool get isUser => role == 'user';
}

class CoachChatState {
  const CoachChatState({
    this.messages = const [],
    this.loading = false,
    this.threadId,
    this.error,
  });

  final List<CoachMessage> messages;
  final bool loading;
  final String? threadId;
  final String? error;

  CoachChatState copyWith({
    List<CoachMessage>? messages,
    bool? loading,
    String? threadId,
    String? error,
    bool clearError = false,
  }) {
    return CoachChatState(
      messages: messages ?? this.messages,
      loading: loading ?? this.loading,
      threadId: threadId ?? this.threadId,
      error: clearError ? null : (error ?? this.error),
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
    if (trimmed.isEmpty || state.loading) return;

    state = state.copyWith(
      messages: [
        ...state.messages,
        CoachMessage(role: 'user', text: trimmed),
      ],
      loading: true,
      clearError: true,
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
      state = state.copyWith(
        messages: [
          ...state.messages,
          CoachMessage(role: 'assistant', text: replyText),
        ],
        loading: false,
        threadId: res.threadId,
      );
    } catch (e) {
      state = state.copyWith(loading: false, error: e.toString());
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
