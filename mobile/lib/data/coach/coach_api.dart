/// Coach Agent (stride-coach-api) client — SSE streaming chat + sessions.
///
/// Mirrors the miniprogram's `services/coach.ts`:
///   - `POST /api/users/me/coach/chat` with `Accept: text/event-stream`,
///     byte-level SSE parsing via [SseParser];
///   - status/narration → progress, text_delta → typewriter,
///     done (authoritative rewrite) / error (three codes) terminate the turn;
///   - idempotency: `client_turn_id` in the body, retries reuse the same id
///     and byte-identical body (server fingerprint = body sha256);
///   - in-stream 401: refresh token once, rebuild parser, retry once;
///   - minute-level idle watchdog + total cap (server sends no heartbeat and
///     season-plan turns run for minutes).
library;

import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';

import '../../core/auth/auth_models.dart';
import '../../core/auth/auth_repository.dart';
import 'sse_parser.dart';

/// Conversation target (`CoachTurnScope` on the server). kind=race requires
/// raceEventId + itemType; week carries folder; session carries date+index.
class CoachTarget {
  const CoachTarget({
    required this.kind,
    this.planId,
    this.folder,
    this.date,
    this.sessionIndex,
    this.raceEventId,
    this.itemType,
  });

  final String kind; // master | week | session | race
  final String? planId;
  final String? folder;
  final String? date;
  final int? sessionIndex;
  final int? raceEventId;
  final String? itemType;

  Map<String, dynamic> toJson() => {
        'kind': kind,
        if (planId != null) 'plan_id': planId,
        if (folder != null) 'folder': folder,
        if (date != null) 'date': date,
        if (sessionIndex != null) 'session_index': sessionIndex,
        if (raceEventId != null) 'race_event_id': raceEventId,
        if (itemType != null) 'item_type': itemType,
      };
}

/// Server `status` event phases (only running_tool|analyzing today).
class CoachStatusEvent {
  const CoachStatusEvent({required this.phase, this.tool, this.toolStatus});

  final String phase;
  final String? tool;
  final String? toolStatus;
}

/// Union of mid-stream events (progress; never the answer body).
sealed class CoachStreamEvent {
  const CoachStreamEvent();
}

class CoachStreamStatus extends CoachStreamEvent {
  const CoachStreamStatus(this.status);
  final CoachStatusEvent status;
}

/// One-shot pre-tool progress note — shown in the progress area, NEVER
/// appended to the answer body.
class CoachStreamNarration extends CoachStreamEvent {
  const CoachStreamNarration(this.delta);
  final String delta;
}

/// Answer body increment (typewriter).
class CoachStreamDelta extends CoachStreamEvent {
  const CoachStreamDelta(this.delta);
  final String delta;
}

/// `done` event payload — `message` is the authoritative final answer
/// (from the server's final values snapshot, not the delta concat).
class CoachDone {
  const CoachDone({this.status, this.message, this.interrupt, this.card});

  final String? status; // completed | needs_input
  final String? message;
  final Object? interrupt; // ask-user payload when needs_input
  final Map<String, dynamic>? card; // {$type, data} envelope
}

/// Terminal failure: one of client_turn_id_conflict | coach_thread_busy |
/// coach_turn_failed, or a client-side code (network/timeout/empty/...).
class CoachStreamError {
  const CoachStreamError(this.code, this.message);

  final String code;
  final String message;

  /// User-facing Chinese line per the error-code layer.
  String get localized {
    switch (code) {
      case 'client_turn_id_conflict':
        return '请求冲突了，请重试';
      case 'coach_thread_busy':
        return '上一条回复还在生成中，请稍候再试';
      case 'coach_turn_failed':
        return '教练本轮生成失败，请重试';
      default:
        return message;
    }
  }
}

class CoachStreamCallbacks {
  const CoachStreamCallbacks({this.onEvent, this.onComplete, this.onError});

  final void Function(CoachStreamEvent event)? onEvent;
  final void Function(CoachDone done)? onComplete;
  final void Function(CoachStreamError error)? onError;
}

class CoachStreamHandle {
  const CoachStreamHandle(this._abort);

  final void Function() _abort;

  /// Stops receiving. The server keeps running the turn to its checkpoint —
  /// an immediate resend with the same id may hit the thread lock (429).
  void abort() => _abort();
}

class CoachHistoryMessage {
  const CoachHistoryMessage({required this.role, required this.content, this.card});

  final String role; // user | assistant
  final String content;
  final Map<String, dynamic>? card; // {$type, data}, attached to its assistant row
}

class CoachHistoryResponse {
  const CoachHistoryResponse({required this.sessionId, required this.messages});

  final String sessionId;
  final List<CoachHistoryMessage> messages;
}

class CoachSessionSummary {
  const CoachSessionSummary({required this.sessionId, this.updatedAt, this.preview});

  final String sessionId;
  final String? updatedAt;
  final String? preview; // first user message, may be empty
}

/// Streaming chat + sessions API against stride-coach-api.
///
/// Uses its own bare Dio (no auth interceptor): the streaming request needs
/// `validateStatus: true` + `ResponseType.stream` and manual 401-refresh
/// semantics; routing it through the shared Dio's 401-retry interceptor would
/// re-buffer the whole stream. JSON endpoints (sessions/history) share the
/// same manual-Bearer policy.
class CoachApi {
  CoachApi({
    required String baseUrl,
    required String clientId,
    required AuthRepository auth,
    this.onSessionExpired,
    this.idleTimeout = const Duration(seconds: 120),
    this.totalTimeout = const Duration(seconds: 660),
  }) : _dio = Dio(BaseOptions(
          baseUrl: baseUrl,
          connectTimeout: const Duration(seconds: 15),
          headers: {
            'Accept': 'application/json',
            'X-Client-Id': clientId,
          },
          validateStatus: (s) => true,
        )),
        _auth = auth;

  final Dio _dio;
  final AuthRepository _auth;
  final void Function()? onSessionExpired;

  /// No heartbeat between long tool calls → idle watchdog must be
  /// minute-level, not the usual 30s receive timeout.
  final Duration idleTimeout;

  /// Total turn cap — server budget is 10 min; 11 min lets the server's
  /// failure text arrive before the client gives up.
  final Duration totalTimeout;

  // ── Streaming chat ───────────────────────────────────────────────────────

  /// Sends one turn and streams events into [callbacks]. Returns an abort
  /// handle. HTTP 401 (initial or mid-stream) → refresh once, rebuild parser,
  /// retry once; refresh failure fires [onSessionExpired].
  CoachStreamHandle sendCoachChatStream({
    required String message,
    required String sessionId,
    required String clientTurnId,
    CoachTarget? target,
    CoachStreamCallbacks callbacks = const CoachStreamCallbacks(),
  }) {
    // Stable body map — retried attempts must be byte-identical (server
    // fingerprint = sha256 of the stable JSON body).
    final body = {
      'session_id': sessionId,
      'message': message,
      'client_turn_id': clientTurnId,
      if (target != null) 'target': target.toJson(),
    };

    var disposed = false;
    var terminal = false;
    Timer? idleTimer;
    Timer? totalTimer;
    CancelToken? cancelToken;
    // Why the in-flight request was cancelled: 'aborted' (user) by default,
    // overwritten by the watchdog timers before they cancel.
    String cancelReason = 'aborted';

    void stopTimers() {
      idleTimer?.cancel();
      totalTimer?.cancel();
      idleTimer = null;
      totalTimer = null;
    }

    void failOnce(CoachStreamError error) {
      if (disposed || terminal) return;
      terminal = true;
      stopTimers();
      callbacks.onError?.call(error);
    }

    void dispatch(SseEvent ev) {
      if (disposed || terminal) return;
      switch (ev.event) {
        case 'done':
          terminal = true;
          stopTimers();
          callbacks.onComplete?.call(_parseDone(ev.data));
        case 'error':
          terminal = true;
          stopTimers();
          final e = _safeParse(ev.data);
          callbacks.onError?.call(CoachStreamError(
            (e['code'] as String?) ?? 'coach_turn_failed',
            (e['message'] as String?) ?? 'coach turn failed',
          ));
        case 'status':
          final e = _safeParse(ev.data);
          callbacks.onEvent?.call(CoachStreamStatus(CoachStatusEvent(
            phase: (e['phase'] as String?) ?? 'analyzing',
            tool: e['tool'] as String?,
            toolStatus: e['tool_status'] as String?,
          )));
        case 'narration':
          final e = _safeParse(ev.data);
          callbacks.onEvent?.call(
              CoachStreamNarration(e['delta'] is String ? e['delta'] as String : ''));
        case 'text_delta':
          final e = _safeParse(ev.data);
          callbacks.onEvent
              ?.call(CoachStreamDelta(e['delta'] is String ? e['delta'] as String : ''));
      }
    }

    void armTimers() {
      stopTimers();
      // Timer periods just cancel the in-flight request; the stream's onDone
      // / error path reports the failure afterwards.
      idleTimer = Timer(idleTimeout, () {
        cancelReason = 'idle_timeout';
        cancelToken?.cancel();
      });
      totalTimer = Timer(totalTimeout, () {
        cancelReason = 'total_timeout';
        cancelToken?.cancel();
      });
    }

    Future<TokenSet?> initialTokens() async {
      var tokens = await _auth.currentTokens();
      if (tokens != null && tokens.isExpired) {
        try {
          tokens = await _auth.refresh(tokens);
        } on AuthException {
          onSessionExpired?.call();
          failOnce(const CoachStreamError('session_expired', '登录已过期'));
          return null;
        }
      }
      return tokens;
    }

    Future<void> attempt(TokenSet? token, {required bool isRetry}) async {
      if (disposed) return;
      // Fresh parser per attempt: no leftover bytes from the aborted round.
      final parser = SseParser();
      var cancelled = false;
      cancelToken = CancelToken();

      final Response<ResponseBody> res;
      try {
        res = await _dio.post<ResponseBody>(
          '/api/users/me/coach/chat',
          data: body,
          cancelToken: cancelToken,
          options: Options(
            responseType: ResponseType.stream,
            validateStatus: (s) => true,
            headers: {
              'Accept': 'text/event-stream',
              'Content-Type': 'application/json',
              if (token != null) 'Authorization': 'Bearer ${token.accessToken}',
            },
          ),
        );
      } catch (e) {
        if (cancelled || disposed) return;
        if (cancelToken?.isCancelled == true) {
          failOnce(switch (cancelReason) {
            'idle_timeout' => const CoachStreamError('timeout', '回复超时，请重试'),
            'total_timeout' => const CoachStreamError('timeout', '生成时间过长，已中止'),
            _ => const CoachStreamError('aborted', '已中止'),
          });
          return;
        }
        failOnce(const CoachStreamError('network', '网络异常，请稍后重试'));
        return;
      }
      if (disposed || cancelled) return;

      final status = res.statusCode ?? 0;
      if (status == 401) {
        // Refresh once, rebuild parser, retry once (fresh attempt above).
        if (isRetry) {
          onSessionExpired?.call();
          failOnce(const CoachStreamError('unauthorized', '登录已过期'));
          return;
        }
        try {
          final current = await _auth.currentTokens();
          if (current == null) throw const AuthException('no tokens');
          final fresh = await _auth.refresh(current);
          await attempt(fresh, isRetry: true);
        } on AuthException {
          onSessionExpired?.call();
          failOnce(const CoachStreamError('session_expired', '登录已过期'));
        } catch (_) {
          failOnce(const CoachStreamError('network', '网络异常，请稍后重试'));
        }
        return;
      }
      if (status < 200 || status >= 300) {
        failOnce(CoachStreamError('http_$status', '请求失败($status)'));
        return;
      }

      final stream = res.data?.stream;
      if (stream == null) {
        failOnce(const CoachStreamError('empty', '未收到回复'));
        return;
      }
      armTimers();
      stream.listen(
        (chunk) {
          if (disposed || cancelled || terminal) return;
          idleTimer?.cancel();
          idleTimer = Timer(idleTimeout, () {
            cancelReason = 'idle_timeout';
            cancelToken?.cancel();
          });
          for (final ev in parser.feed(chunk)) {
            dispatch(ev);
          }
        },
        onError: (Object e) {
          if (disposed || cancelled || terminal) return;
          failOnce(const CoachStreamError('network', '网络异常，请稍后重试'));
        },
        onDone: () {
          if (disposed || cancelled || terminal) return;
          stopTimers();
          // 2xx but stream closed without a done/error: flush the residual
          // bytes first to recover a truncated final event.
          for (final ev in parser.flush()) {
            dispatch(ev);
          }
          if (!terminal) {
            failOnce(const CoachStreamError('empty', '未收到回复'));
          }
        },
        cancelOnError: true,
      );
    }

    void start() {
      initialTokens().then((tokens) {
        if (disposed || terminal) return;
        if (tokens == null) {
          onSessionExpired?.call();
          failOnce(const CoachStreamError('unauthorized', '请先登录'));
          return;
        }
        attempt(tokens, isRetry: false);
      });
    }

    start();

    return CoachStreamHandle(() {
      disposed = true;
      stopTimers();
      cancelReason = 'aborted';
      cancelToken?.cancel();
    });
  }

  CoachDone _parseDone(String data) {
    final e = _safeParse(data);
    return CoachDone(
      status: e['status'] as String?,
      message: e['message'] as String?,
      interrupt: e['interrupt'],
      card: e['card'] is Map<String, dynamic> ? e['card'] as Map<String, dynamic> : null,
    );
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  /// `GET /api/users/me/coach/sessions` — all sessions, newest first.
  Future<List<CoachSessionSummary>> fetchSessions() async {
    final data = await _getJson('/api/users/me/coach/sessions');
    final list = data['sessions'];
    if (list is! List) return const [];
    return [
      for (final s in list)
        if (s is Map<String, dynamic> && s['session_id'] is String)
          CoachSessionSummary(
            sessionId: s['session_id'] as String,
            updatedAt: s['updated_at'] as String?,
            preview: s['preview'] as String?,
          ),
    ];
  }

  /// `GET /api/users/me/coach/sessions/{id}/messages` — user/assistant rows.
  Future<CoachHistoryResponse> fetchHistory(String sessionId) async {
    final data = await _getJson(
        '/api/users/me/coach/sessions/${Uri.encodeComponent(sessionId)}/messages');
    final list = data['messages'];
    return CoachHistoryResponse(
      sessionId: (data['session_id'] as String?) ?? sessionId,
      messages: [
        if (list is List)
          for (final m in list)
            if (m is Map<String, dynamic> && m['content'] is String)
              CoachHistoryMessage(
                role: (m['role'] as String?) == 'user' ? 'user' : 'assistant',
                content: m['content'] as String,
                card: m['card'] is Map<String, dynamic>
                    ? m['card'] as Map<String, dynamic>
                    : null,
              ),
      ],
    );
  }

  /// Bare GET with manual Bearer + one 401-refresh retry (short JSON calls).
  Future<Map<String, dynamic>> _getJson(String path) async {
    for (var attempt = 0;; attempt++) {
      final tokens = await _auth.currentTokens();
      if (tokens == null) {
        onSessionExpired?.call();
        throw const CoachApiException('unauthorized', '请先登录');
      }
      final res = await _dio.get<Map<String, dynamic>>(
        path,
        options: Options(validateStatus: (s) => true, headers: {
          if (!tokens.isExpired) 'Authorization': 'Bearer ${tokens.accessToken}',
        }),
      );
      if (res.statusCode == 401) {
        if (attempt > 0) {
          onSessionExpired?.call();
          throw const CoachApiException('unauthorized', '登录已过期');
        }
        try {
          await _auth.refresh(tokens);
          continue;
        } on AuthException {
          onSessionExpired?.call();
          throw const CoachApiException('session_expired', '登录已过期');
        }
      }
      final status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        throw CoachApiException('http_$status', '请求失败($status)');
      }
      return res.data ?? const <String, dynamic>{};
    }
  }
}

class CoachApiException implements Exception {
  const CoachApiException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => message;
}

Map<String, dynamic> _safeParse(String s) {
  try {
    final v = jsonDecode(s);
    return v is Map<String, dynamic> ? v : const <String, dynamic>{};
  } catch (_) {
    return const <String, dynamic>{};
  }
}
