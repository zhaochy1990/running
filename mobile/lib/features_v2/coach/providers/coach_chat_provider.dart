import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/auth_controller.dart';
import '../../../core/env/env.dart';
import '../../../data/api/coach_turn_id.dart';
import '../../../data/coach/coach_api.dart';
import '../../../data/coach/coach_cards.dart';

/// Default session id — stable across restarts so the standing conversation
/// continues (mirrors the miniprogram's `mini-default`). Legacy `qa-*` /
/// `week-*` sessions survive in the drawer via the shared checkpoint store.
const kDefaultCoachSessionId = 'flutter-default';

const _kPlaceholderTitle = '新对话';
const _kDefaultTitle = '与教练的对话';

/// server status phase → user-facing hint (two visible stages).
String coachPhaseLabel(String phase) =>
    (phase == 'running_tool' || phase == 'in_subagent') ? '正在查询数据…' : '正在分析…';

/// Cross-tab coach handoff (训练页「和教练聊一聊」→ 教练 tab): machine-readable
/// target + display label, consumed once on arrival.
class PendingCoachContext {
  const PendingCoachContext({required this.target, required this.label});

  final CoachTarget target;

  /// Display label, e.g. 「轻松跑 12km · 9月8日」.
  final String label;
}

final pendingCoachContextProvider = StateProvider<PendingCoachContext?>((ref) => null);

/// Strategy draft handoff (chat race-strategy card → strategy report page).
/// Written only when the session's target is kind=race with a race_event_id;
/// the report page reads it once and clears (raceId mismatch → discard).
/// shortcut: no report page in the app yet — PR-8 (赛事域 #466) consumes this.
final pendingStrategyDraftProvider = StateProvider<PendingStrategyDraft?>((ref) => null);

/// One chat bubble.
class CoachMessage {
  CoachMessage({
    required this.id,
    required this.role,
    required this.content,
    this.card,
    this.clientTurnId,
    this.failed = false,
  });

  final int id;
  final String role; // 'user' | 'assistant'
  final String content;
  final CoachCardView? card; // notification card replaces markdown rendering
  final String? clientTurnId; // user message: reused by the retry button
  final bool failed; // user message: turn failed → show retry
}

/// Locally-known session. id maps 1:1 to the server thread `{user}:coach:{id}`.
class CoachSessionInfo {
  CoachSessionInfo({required this.id, required this.title, this.target, this.contextLabel});

  final String id;
  String title;

  /// Plan anchor for the whole session (sent with every turn).
  CoachTarget? target;

  /// Display label for the context banner.
  String? contextLabel;
}

class CoachChatState {
  const CoachChatState({
    this.sessions = const [],
    this.currentSessionId = kDefaultCoachSessionId,
    this.messages = const [],
    this.streaming = false,
    this.streamPhase = '',
    this.streamNarration = '',
    this.streamText = '',
    this.loadError,
  });

  final List<CoachSessionInfo> sessions;
  final String currentSessionId;
  final List<CoachMessage> messages;

  /// True while a turn is in flight (input disabled, streaming bubble shown).
  final bool streaming;
  final String streamPhase; // stage hint, e.g. 「正在分析…」
  final String streamNarration; // pre-tool progress note (never the body)
  final String streamText; // typewriter display text
  final String? loadError; // sessions/history/stream failure (non-blocking)

  CoachSessionInfo? sessionOf(String id) => sessions.firstWhereOrNull((s) => s.id == id);

  CoachChatState copyWith({
    List<CoachSessionInfo>? sessions,
    String? currentSessionId,
    List<CoachMessage>? messages,
    bool? streaming,
    String? streamPhase,
    String? streamNarration,
    String? streamText,
    String? loadError,
    bool clearLoadError = false,
    bool clearStream = false,
  }) {
    return CoachChatState(
      sessions: sessions ?? this.sessions,
      currentSessionId: currentSessionId ?? this.currentSessionId,
      messages: messages ?? this.messages,
      streaming: streaming ?? this.streaming,
      streamPhase: clearStream ? '' : (streamPhase ?? this.streamPhase),
      streamNarration: clearStream ? '' : (streamNarration ?? this.streamNarration),
      streamText: clearStream ? '' : (streamText ?? this.streamText),
      loadError: clearLoadError ? null : (loadError ?? this.loadError),
    );
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? firstWhereOrNull(bool Function(T) test) {
    for (final x in this) {
      if (test(x)) return x;
    }
    return null;
  }
}

class CoachChatNotifier extends StateNotifier<CoachChatState> {
  CoachChatNotifier(this._api, {void Function(PendingStrategyDraft?)? onStrategyDraft})
      : _onStrategyDraft = onStrategyDraft ?? ((_) {}),
        super(
          const CoachChatState().copyWith(
            sessions: [
              CoachSessionInfo(id: kDefaultCoachSessionId, title: _kDefaultTitle),
            ],
          ),
        );

  final CoachApi _api;
  final void Function(PendingStrategyDraft?) _onStrategyDraft;

  int _seq = 0;
  CoachStreamHandle? _abort;
  // Delta throttling: merge deltas arriving in the same frame into one state
  // write (MP's 16ms flush timer).
  final StringBuffer _deltaBuffer = StringBuffer();
  final StringBuffer _rawStreamText = StringBuffer();
  Timer? _flushTimer;

  CoachSessionInfo? get _currentSession => state.sessionOf(state.currentSessionId);

  // ── Send / retry ─────────────────────────────────────────────────────────

  void sendMessage(String text) {
    final trimmed = text.trim();
    if (trimmed.isEmpty || state.streaming) return;
    _refreshTitle(trimmed);
    final turnId = createCoachClientTurnId();
    final userMsg = CoachMessage(id: ++_seq, role: 'user', content: trimmed, clientTurnId: turnId);
    state = state.copyWith(
      messages: [...state.messages, userMsg],
      streaming: true,
      clearStream: true,
      clearLoadError: true,
    );
    _doSend(trimmed, turnId, userMsg.id);
  }

  /// Failed turn retry: reuses the same client_turn_id + byte-identical body
  /// (server idempotency returns the same turn instead of re-running).
  void retry(int userMsgId) {
    if (state.streaming) return;
    final msg = state.messages.firstWhereOrNull((m) => m.id == userMsgId);
    if (msg == null || msg.role != 'user' || msg.clientTurnId == null) return;
    state = state.copyWith(streaming: true, clearStream: true);
    _doSend(msg.content, msg.clientTurnId!, userMsgId);
  }

  void _doSend(String text, String clientTurnId, int userMsgId) {
    _resetStreamBuffers();
    state = state.copyWith(streaming: true, clearStream: true, clearLoadError: true);
    _abort = _api.sendCoachChatStream(
      message: text,
      sessionId: state.currentSessionId,
      clientTurnId: clientTurnId,
      target: _currentSession?.target,
      callbacks: CoachStreamCallbacks(
        onEvent: _onStreamEvent,
        onComplete: (done) => _finishStream(done, userMsgId),
        onError: (error) => _failStream(error, userMsgId),
      ),
    );
  }

  void _onStreamEvent(CoachStreamEvent ev) {
    if (!state.streaming) return;
    switch (ev) {
      case CoachStreamNarration(:final delta):
        // One-shot pre-tool note — progress area only, never the body.
        final t = delta.trim();
        if (t.isNotEmpty && t != state.streamNarration) {
          state = state.copyWith(streamNarration: t);
        }
      case CoachStreamDelta(:final delta):
        _deltaBuffer.write(delta);
        _flushTimer ??= Timer(const Duration(milliseconds: 16), () {
          _flushTimer = null;
          _rawStreamText.write(_deltaBuffer);
          _deltaBuffer.clear();
          final raw = _rawStreamText.toString();
          // Leaked envelope JSON gets a neutral placeholder while streaming;
          // done/card + history self-heal take over afterwards.
          final display = looksLikeJsonText(raw) ? '正在整理内容…' : raw;
          state = state.copyWith(streamText: display);
        });
      case CoachStreamStatus(:final status):
        final label = coachPhaseLabel(status.phase);
        if (label != state.streamPhase) state = state.copyWith(streamPhase: label);
    }
  }

  void _finishStream(CoachDone done, int userMsgId) {
    _abort = null;
    _resetStreamBuffers();
    // completed → done.message (authoritative); needs_input → the ask-user
    // question renders as an assistant follow-up, not a failure.
    var content = done.status == 'completed' ? done.message : interruptText(done.interrupt);
    final card = done.card == null ? null : buildCoachCard(done.card);
    if ((content == null || content.trim().isEmpty) && card == null) {
      _failStream(const CoachStreamError('empty', '未收到回复'), userMsgId);
      return;
    }
    if (content == null || content.trim().isEmpty) content = card?.title ?? '';
    final assistant = CoachMessage(id: ++_seq, role: 'assistant', content: content, card: card);
    state = state.copyWith(
      messages: [..._markFailed(userMsgId, failed: false), assistant],
      streaming: false,
      clearStream: true,
    );
  }

  void _failStream(CoachStreamError error, int userMsgId) {
    _abort = null;
    _resetStreamBuffers();
    state = state.copyWith(
      messages: _markFailed(userMsgId, failed: true),
      streaming: false,
      clearStream: true,
      loadError: error.localized,
    );
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  /// New empty session; the server thread materializes on first chat.
  void newConversation() {
    _abortStream();
    final session = CoachSessionInfo(id: createCoachSessionId(), title: _kPlaceholderTitle);
    state = state.copyWith(
      sessions: [session, ...state.sessions],
      currentSessionId: session.id,
      messages: const [],
    );
  }

  Future<void> selectSession(String id) async {
    if (id == state.currentSessionId) return;
    _abortStream();
    state = state.copyWith(currentSessionId: id, messages: const []);
    await loadSession(id);
  }

  /// Refresh the drawer from the server (newest first), merging local-only
  /// metadata (target/contextLabel live only here) and keeping not-yet-synced
  /// local sessions. Server failure keeps the local list (non-blocking).
  Future<void> loadSessions() async {
    try {
      final remote = await _api.fetchSessions();
      if (!mounted) return;
      final localById = {for (final s in state.sessions) s.id: s};
      final list = [
        for (final s in remote)
          CoachSessionInfo(
            id: s.sessionId,
            title: (s.preview?.trim().isNotEmpty ?? false) ? s.preview!.trim() : _kPlaceholderTitle,
            target: localById[s.sessionId]?.target,
            contextLabel: localById[s.sessionId]?.contextLabel,
          ),
      ];
      final remoteIds = remote.map((s) => s.sessionId).toSet();
      for (final local in state.sessions) {
        if (!remoteIds.contains(local.id)) list.add(local);
      }
      // 服务端尚未落库的当前会话（本地刚新建、还没发过消息）置顶，
      // 避免「当前」徽标失效（MP 同款语义）。
      final currentId = state.currentSessionId;
      final currentIndex = list.indexWhere((s) => s.id == currentId);
      if (currentIndex > 0) {
        final current = list.removeAt(currentIndex);
        list.insert(0, current);
      }
      state = state.copyWith(sessions: list, clearLoadError: true);
    } on CoachApiException catch (e) {
      if (mounted) state = state.copyWith(loadError: e.message);
    } catch (_) {
      // Offline / backend unavailable — local list stays usable.
    }
  }

  /// Load a session's history. Keeps the current view on failure; drops the
  /// result if the user switched sessions while loading.
  Future<void> loadSession(String sessionId) async {
    _abortStream();
    try {
      final history = await _api.fetchHistory(sessionId);
      if (!mounted || state.currentSessionId != sessionId) return;
      final msgs = <CoachMessage>[
        for (final m in history.messages)
          if (m.role == 'assistant')
            _assistantFromHistory(++_seq, m)
          else
            CoachMessage(id: ++_seq, role: 'user', content: m.content),
      ];
      state = state.copyWith(messages: msgs, clearLoadError: true);
    } on CoachApiException catch (e) {
      if (mounted && state.currentSessionId == sessionId) {
        state = state.copyWith(loadError: e.message);
      }
    } catch (_) {
      // History fetch failed — keep the current (empty) view, chat still works.
    }
  }

  /// Consume the cross-tab handoff: create a session anchored to the target
  /// and show its context banner.
  void consumePendingContext(PendingCoachContext pending) {
    _abortStream();
    final session = CoachSessionInfo(
      id: createCoachSessionId(),
      title: _kPlaceholderTitle,
      target: pending.target,
      contextLabel: pending.label,
    );
    state = state.copyWith(
      sessions: [session, ...state.sessions],
      currentSessionId: session.id,
      messages: const [],
    );
  }

  /// Clear the current session's target — subsequent turns send no target.
  void clearContext() {
    final id = state.currentSessionId;
    state = state.copyWith(
      sessions: [
        for (final s in state.sessions)
          if (s.id == id)
            CoachSessionInfo(id: s.id, title: s.title)
          else
            s,
      ],
    );
  }

  /// Race-strategy card tap → one-shot draft handoff for the report page.
  /// Returns false when the session has no race target (nothing to hand off).
  bool openStrategyCard(int messageId) {
    final msg = state.messages.firstWhereOrNull((m) => m.id == messageId);
    if (msg?.card?.type != 'race-strategy') return false;
    final target = _currentSession?.target;
    if (target?.kind != 'race' || target?.raceEventId == null) return false;
    final data = msg!.card!.data;
    if (data is! Map<String, dynamic>) return false;
    _onStrategyDraft(PendingStrategyDraft(raceId: target!.raceEventId!, strategy: data));
    return true;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  void _refreshTitle(String text) {
    final session = _currentSession;
    if (session == null ||
        (session.title != _kPlaceholderTitle && session.title != _kDefaultTitle)) {
      return;
    }
    final trimmed = text.trim().replaceAll(RegExp(r'\s+'), ' ');
    final title = trimmed.length > 12 ? '${trimmed.substring(0, 12)}…' : trimmed;
    state = state.copyWith(
      sessions: [
        for (final s in state.sessions)
          if (s.id == session.id)
            CoachSessionInfo(
              id: s.id,
              title: title,
              target: s.target,
              contextLabel: s.contextLabel,
            )
          else
            s,
      ],
    );
  }

  void _abortStream() {
    _abort?.abort();
    _abort = null;
    _resetStreamBuffers();
    state = state.copyWith(streaming: false);
  }

  void _resetStreamBuffers() {
    _flushTimer?.cancel();
    _flushTimer = null;
    _deltaBuffer.clear();
    _rawStreamText.clear();
  }

  List<CoachMessage> _markFailed(int userMsgId, {required bool failed}) => [
        for (final m in state.messages)
          if (m.id == userMsgId)
            CoachMessage(
              id: m.id,
              role: m.role,
              content: m.content,
              card: m.card,
              clientTurnId: m.clientTurnId,
              failed: failed,
            )
          else
            m,
      ];

  /// Assistant history row → bubble: server envelope first, then the
  /// leaked-envelope self-heal, else plain markdown.
  CoachMessage _assistantFromHistory(int id, CoachHistoryMessage m) {
    final fromServer = buildCoachCard(m.card);
    if (fromServer != null) {
      return CoachMessage(id: id, role: 'assistant', content: m.content, card: fromServer);
    }
    final leaked = parseLeakedRaceStrategyEnvelope(m.content);
    if (leaked != null) {
      final card = buildCoachCard({r'$type': leaked.type, 'data': leaked.data});
      if (card != null) {
        return CoachMessage(id: id, role: 'assistant', content: m.content, card: card);
      }
    }
    return CoachMessage(id: id, role: 'assistant', content: m.content);
  }

  @override
  void dispose() {
    _abort?.abort();
    _flushTimer?.cancel();
    super.dispose();
  }
}

/// needs_input interrupt payload → displayable question.
String? interruptText(Object? interrupt) {
  if (interrupt is String) return interrupt.isEmpty ? null : interrupt;
  if (interrupt is Map) {
    final question = interrupt['question'];
    final header = interrupt['header'];
    if (question is String && question.isNotEmpty) return question;
    if (header is String && header.isNotEmpty) return header;
  }
  return null;
}

final coachApiProvider = Provider<CoachApi>((ref) {
  return CoachApi(
    baseUrl: Env.apiBaseUrl,
    clientId: Env.clientId,
    auth: ref.watch(authRepositoryProvider),
    onSessionExpired: () => ref.read(authControllerProvider.notifier).logout(),
  );
});

final coachChatProvider = StateNotifierProvider<CoachChatNotifier, CoachChatState>((ref) {
  return CoachChatNotifier(
    ref.watch(coachApiProvider),
    onStrategyDraft: (draft) => ref.read(pendingStrategyDraftProvider.notifier).state = draft,
  );
});
