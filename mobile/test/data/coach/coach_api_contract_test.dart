import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/auth_models.dart';
import 'package:stride/core/auth/auth_repository.dart';
import 'package:stride/data/coach/coach_api.dart';

/// Contract test: real SSE byte stream from a local HTTP server, asserting the
/// event-sequence handling, idempotent request shape, 401-refresh-retry-once,
/// flush recovery and abort semantics against the actual wire format
/// (stride-devops#421 resolution appendix / #464 自验).
void main() {
  late HttpServer server;
  late List<Map<String, String>> authHeaders;
  late List<Map<String, dynamic>> bodies;

  final tokens = TokenSet(
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
  );
  final refreshed = TokenSet(
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
    expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
  );

  setUp(() async {
    authHeaders = [];
    bodies = [];
    server = await HttpServer.bind('127.0.0.1', 0);
  });

  tearDown(() async {
    await server.close(force: true);
  });

  String sse(String event, Map<String, dynamic> data) =>
      'event: $event\ndata: ${jsonEncode(data)}\n\n';

  CoachApi buildApi({
    required AuthRepository auth,
    Duration idle = const Duration(seconds: 5),
  }) {
    return CoachApi(
      baseUrl: 'http://127.0.0.1:${server.port}',
      clientId: 'test-client',
      auth: auth,
      idleTimeout: idle,
      totalTimeout: const Duration(seconds: 30),
    );
  }

  test('streams status → narration → text_delta → done and done.message is authoritative',
      () async {
    server.listen((req) async {
      authHeaders.add({
        'authorization': req.headers.value('authorization') ?? '',
        'accept': req.headers.value('accept') ?? '',
        'x-client-id': req.headers.value('x-client-id') ?? '',
      });
      bodies.add(jsonDecode(await utf8.decoder.bind(req).first) as Map<String, dynamic>);
      final out = req.response;
      out.headers.contentType = ContentType('text', 'event-stream');
      void write(String s) => out.add(utf8.encode(s));
      write(sse('status', {'turn_id': 't1', 'phase': 'running_tool', 'tool_status': 'running'}));
      await out.flush();
      write(sse('narration', {'turn_id': 't1', 'delta': '先查一下你最近一周的训练数据'}));
      await out.flush();
      // Split a multi-byte char across two chunks.
      final bytes = utf8.encode(sse('text_delta', {'turn_id': 't1', 'delta': '今天状态不错'}));
      out.add(bytes.sublist(0, bytes.length - 4));
      await out.flush();
      out.add(bytes.sublist(bytes.length - 4));
      await out.flush();
      write(sse('done', {
        'turn_id': 't1',
        'status': 'completed',
        'message': '今天状态不错，按计划轻松跑即可。',
        'card': null,
      }));
      await out.close();
    });

    final events = <CoachStreamEvent>[];
    CoachDone? done;
    final api = buildApi(auth: _FixedAuth(tokens));
    api.sendCoachChatStream(
      message: '今天怎么跑？',
      sessionId: 'flutter-1',
      clientTurnId: 'flutter-turn-1',
      target: const CoachTarget(kind: 'session', date: '2026-10-14', sessionIndex: 0),
      callbacks: CoachStreamCallbacks(
        onEvent: events.add,
        onComplete: (d) => done = d,
        onError: (e) => fail('unexpected error: ${e.code}'),
      ),
    );

    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(events.map((e) => e.runtimeType).toList(), [
      CoachStreamStatus,
      CoachStreamNarration,
      CoachStreamDelta,
    ]);
    expect(done, isNotNull);
    expect(done!.status, 'completed');
    expect(done!.message, '今天状态不错，按计划轻松跑即可。');

    // Request contract: Accept header, X-Client-Id, snake_case body w/ target.
    expect(authHeaders.single['accept'], 'text/event-stream');
    expect(authHeaders.single['authorization'], 'Bearer access-1');
    expect(authHeaders.single['x-client-id'], 'test-client');
    expect(bodies.single, {
      'session_id': 'flutter-1',
      'message': '今天怎么跑？',
      'client_turn_id': 'flutter-turn-1',
      'target': {'kind': 'session', 'date': '2026-10-14', 'session_index': 0},
    });
  });

  test('error event surfaces the three server codes', () async {
    server.listen((req) async {
      req.response.add(utf8.encode(sse('error', {
        'turn_id': 't1',
        'code': 'coach_thread_busy',
        'message': 'busy',
      })));
      await req.response.close();
    });
    CoachStreamError? error;
    buildApi(auth: _FixedAuth(tokens)).sendCoachChatStream(
      message: 'hi',
      sessionId: 's',
      clientTurnId: 't',
      callbacks: CoachStreamCallbacks(onError: (e) => error = e),
    );
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(error?.code, 'coach_thread_busy');
    expect(error?.localized, '上一条回复还在生成中，请稍候再试');
  });

  test('401 → refresh once → byte stream retried with the new token', () async {
    var requests = 0;
    server.listen((req) async {
      requests += 1;
      authHeaders.add({'authorization': req.headers.value('authorization') ?? ''});
      if (requests == 1) {
        await (req.response..statusCode = 401).close();
        return;
      }
      req.response.add(utf8.encode(sse('done', {
        'turn_id': 't1',
        'status': 'completed',
        'message': 'ok',
      })));
      await req.response.close();
    });
    final auth = _RefreshingAuth(tokens, refreshed);
    CoachDone? done;
    buildApi(auth: auth).sendCoachChatStream(
      message: 'hi',
      sessionId: 's',
      clientTurnId: 't',
      callbacks: CoachStreamCallbacks(
        onComplete: (d) => done = d,
        onError: (e) => fail('unexpected error: ${e.code}'),
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(requests, 2);
    expect(auth.refreshCalls, 1);
    expect(authHeaders[0]['authorization'], 'Bearer access-1');
    expect(authHeaders[1]['authorization'], 'Bearer access-2');
    expect(done?.message, 'ok');
  });

  test('stream closed without terminator: flush recovers the truncated done', () async {
    server.listen((req) async {
      // No trailing \n\n — the final event only terminates via flush().
      req.response.add(utf8.encode('event: done\ndata: {"turn_id":"t1","status":"completed","message":"尾部截断"}'));
      await req.response.close();
    });
    CoachDone? done;
    buildApi(auth: _FixedAuth(tokens)).sendCoachChatStream(
      message: 'hi',
      sessionId: 's',
      clientTurnId: 't',
      callbacks: CoachStreamCallbacks(
        onComplete: (d) => done = d,
        onError: (e) => fail('unexpected error: ${e.code}'),
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(done?.message, '尾部截断');
  });

  test('abort stops the stream silently (no error UI)', () async {
    final completer = Completer<void>();
    server.listen((req) async {
      req.response.add(utf8.encode(
          sse('status', {'turn_id': 't1', 'phase': 'running_tool', 'tool_status': 'running'})));
      await req.response.flush();
      await completer.future; // hold the stream open
    });
    final errors = <CoachStreamError>[];
    final handle = buildApi(auth: _FixedAuth(tokens), idle: const Duration(seconds: 30))
        .sendCoachChatStream(
      message: 'hi',
      sessionId: 's',
      clientTurnId: 't',
      callbacks: CoachStreamCallbacks(onError: errors.add),
    );
    await Future<void>.delayed(const Duration(milliseconds: 100));
    handle.abort();
    await Future<void>.delayed(const Duration(milliseconds: 100));
    completer.complete();
    // abort 是用户主动切走：静默收场，不出错误回调（MP 同款语义）。
    expect(errors, isEmpty);
  });
}

class _FixedAuth extends AuthRepository {
  _FixedAuth(this._tokens);

  final TokenSet _tokens;

  @override
  Future<TokenSet?> currentTokens() async => _tokens;

  @override
  Future<TokenSet> refresh(TokenSet current) async => _tokens;
}

class _RefreshingAuth extends AuthRepository {
  _RefreshingAuth(this._tokens, this._refreshed);

  final TokenSet _tokens;
  final TokenSet _refreshed;
  int refreshCalls = 0;

  @override
  Future<TokenSet?> currentTokens() async => _tokens;

  @override
  Future<TokenSet> refresh(TokenSet current) async {
    refreshCalls += 1;
    return _refreshed;
  }
}
