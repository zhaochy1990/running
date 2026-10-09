import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/coach_turn_id.dart';
import '../../../data/api/stride_api.dart';

/// 跨页交接的教练消息预填（如 /training 的「和教练聊一聊」入口）。
/// 教练 tab 消费后立即清空。
final pendingCoachMessageProvider = StateProvider<String?>((ref) => null);

/// A single chat message in the 教练 (S3 daily Q&A) transcript.
class CoachMessage {
  const CoachMessage({required this.role, required this.text});
  final String role; // 'user' | 'assistant' | 'event'
  final String text;

  bool get isUser => role == 'user';
  bool get isEvent => role == 'event';
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
          : [...state.messages, CoachMessage(role: 'user', text: trimmed)],
      loading: true,
      clearError: true,
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
      _pendingMessage = null;
      _pendingClientTurnId = null;
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
