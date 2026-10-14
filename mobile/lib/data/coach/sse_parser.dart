/// Byte-level incremental SSE (Server-Sent Events) parser — Dart port of the
/// miniprogram's `utils/sse.ts`.
///
/// The coach backend streams via Hono `stream.writeSSE`:
///
///   event: status\n     data: {"turn_id":"...","phase":"..."}\n\n
///   event: text_delta\n data: {"turn_id":"...","delta":"..."}\n\n
///   event: done\n       data: {"turn_id":"...","status":"completed","message":"..."}\n\n
///   event: error\n      data: {"turn_id":"...","code":"...","message":"..."}\n\n
///
/// Network chunks arrive at arbitrary byte boundaries, so bytes are
/// accumulated and only decoded when a full event terminator (\n\n or
/// \r\n\r\n) has arrived — a terminator is a single ASCII byte and can never
/// land inside a multi-byte UTF-8 code point, so "decode only complete
/// blocks" is inherently multi-byte safe. `flush()` recovers a trailing
/// unterminated block when the connection closes (truncated final event).
library;

import 'dart:convert';

/// One parsed SSE event (`event:` + joined `data:` lines + optional `id:`).
class SseEvent {
  const SseEvent({required this.event, required this.data, this.id});

  final String event;
  final String data;
  final String? id;
}

/// Incremental SSE parser. `feed` accumulates bytes across chunks and emits
/// every complete event in arrival order; `flush` emits the residual
/// unterminated block at end-of-stream.
class SseParser {
  final List<int> _buffer = <int>[];

  List<SseEvent> feed(List<int> bytes) {
    if (bytes.isNotEmpty) _buffer.addAll(bytes);
    final events = <SseEvent>[];
    for (;;) {
      final end = _findEventEnd(_buffer);
      if (end < 0) break;
      final block = _buffer.sublist(0, end);
      _buffer.removeRange(0, end);
      events.add(_parseEventBlock(block));
    }
    return events;
  }

  List<SseEvent> flush() {
    if (_buffer.isEmpty) return const [];
    final block = _buffer.sublist(0);
    _buffer.clear();
    return [_parseEventBlock(block)];
  }
}

/// Index just past the next event terminator, or -1 when none is buffered.
int _findEventEnd(List<int> buf) {
  for (var i = 0; i < buf.length - 3; i++) {
    if (buf[i] == 13 && buf[i + 1] == 10 && buf[i + 2] == 13 && buf[i + 3] == 10) {
      return i + 4;
    }
  }
  for (var i = 0; i < buf.length - 1; i++) {
    if (buf[i] == 10 && buf[i + 1] == 10) return i + 2;
  }
  return -1;
}

SseEvent _parseEventBlock(List<int> block) {
  // allowMalformed mirrors the TS decoder: invalid/truncated sequences become
  // U+FFFD instead of throwing mid-stream.
  final text = utf8AllowMalformed(block).replaceAll('\r\n', '\n');
  var event = '';
  var id = '';
  final dataLines = <String>[];
  for (final line in text.split('\n')) {
    if (line.isEmpty) continue;
    if (line.startsWith(':')) continue; // comment / keep-alive line
    final colon = line.indexOf(':');
    final field = colon < 0 ? line : line.substring(0, colon);
    var value = colon < 0 ? '' : line.substring(colon + 1);
    if (value.startsWith(' ')) value = value.substring(1);
    if (field == 'event') {
      event = value;
    } else if (field == 'id') {
      id = value;
    } else if (field == 'data') {
      dataLines.add(value);
    }
  }
  return SseEvent(event: event, data: dataLines.join('\n'), id: id.isEmpty ? null : id);
}

/// `utf8.decode` with malformed sequences replaced by U+FFFD (never throws).
String utf8AllowMalformed(List<int> bytes) =>
    utf8.decode(bytes, allowMalformed: true);
