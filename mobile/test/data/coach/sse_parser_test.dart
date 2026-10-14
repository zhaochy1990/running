import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:stride/data/coach/sse_parser.dart';

void main() {
  group('SseParser', () {
    test('parses a complete event sequence', () {
      final parser = SseParser();
      const raw = 'event: status\n'
          'data: {"turn_id":"t1","phase":"running_tool","tool_status":"running"}\n\n'
          'event: text_delta\n'
          'data: {"turn_id":"t1","delta":"你好"}\n\n';
      final events = parser.feed(utf8.encode(raw));
      expect(events, hasLength(2));
      expect(events[0].event, 'status');
      expect(events[0].data, '{"turn_id":"t1","phase":"running_tool","tool_status":"running"}');
      expect(events[1].event, 'text_delta');
    });

    test('byte-by-byte feeding survives event terminators split across chunks', () {
      final parser = SseParser();
      const raw = 'event: done\n'
          'data: {"turn_id":"t1","status":"completed","message":"你好，正在分析"}\n\n';
      final events = <SseEvent>[];
      for (final b in utf8.encode(raw)) {
        events.addAll(parser.feed([b]));
      }
      expect(events, hasLength(1));
      expect(events[0].event, 'done');
      // Multi-byte UTF-8 (你好 = 6 bytes) reassembles intact.
      expect(events[0].data, contains('你好，正在分析'));
    });

    test('a multi-byte code point split mid-sequence is not corrupted', () {
      final parser = SseParser();
      final eventBytes = utf8.encode('event: text_delta\ndata: {"delta":"正"}\n\n');
      // '正' occupies the 3 bytes before the closing '"}' — cut inside it.
      final splitAt = eventBytes.length - 6;
      expect(eventBytes[splitAt], 0xAD);
      final events = [
        ...parser.feed(eventBytes.sublist(0, splitAt)),
        ...parser.feed(eventBytes.sublist(splitAt)),
      ];
      expect(events, hasLength(1));
      expect(events[0].data, '{"delta":"正"}');
    });

    test('CRLF terminators (\\r\\n\\r\\n) are honored', () {
      final parser = SseParser();
      final events = parser.feed(utf8.encode('event: status\r\ndata: {"phase":"analyzing"}\r\n\r\n'));
      expect(events, hasLength(1));
      expect(events[0].event, 'status');
      expect(events[0].data, '{"phase":"analyzing"}');
    });

    test('comment lines and id fields are handled; multi-line data joins with \\n', () {
      final parser = SseParser();
      const raw = ': keep-alive\n'
          'id: 42\n'
          'event: narration\n'
          'data: line1\n'
          'data: line2\n\n';
      final events = parser.feed(utf8.encode(raw));
      expect(events, hasLength(1));
      expect(events[0].event, 'narration');
      expect(events[0].id, '42');
      expect(events[0].data, 'line1\nline2');
    });

    test('incomplete events are buffered; flush recovers the residual block', () {
      final parser = SseParser();
      expect(parser.feed(utf8.encode('event: done\ndata: {"a":1}')), isEmpty);
      final flushed = parser.flush();
      expect(flushed, hasLength(1));
      expect(flushed[0].event, 'done');
      expect(parser.flush(), isEmpty);
    });
  });
}
