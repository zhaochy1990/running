import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:stride/data/coach/coach_cards.dart';

void main() {
  final strategy = <String, dynamic>{
    'race_name': '上海马拉松',
    'item_type': 'full_marathon',
    'target_finish_time': '3:30:00',
    'summary': '前半程压住配速',
    'pace_segments': [
      {'segment': '0-21km', 'pace': '4:58', 'distance_km': 21, 'segment_time': '1:44:50', 'cumulative_time': '1:44:50', 'note': '压住'},
    ],
    'fueling_plan': [
      {'time_point': '0km', 'content': '能量胶'},
    ],
    'course_tips': ['注意折返'],
    'weather_tips': ['顺风段'],
    'basis_note': '基于近期训练',
  };

  group('buildCoachCard', () {
    test('race-strategy envelope → view', () {
      final card = buildCoachCard({r'$type': 'race-strategy', 'data': strategy});
      expect(card, isNotNull);
      expect(card!.type, 'race-strategy');
      expect(card.title, '比赛策略已生成');
      expect(card.badge, '初稿');
      expect(card.buttonText, '查看详情');
      expect(card.subtitle, contains('上海马拉松'));
      expect(card.subtitle, contains('3:30:00'));
      expect(card.data, same(strategy));
    });

    test('unknown \$type / shape mismatch → null (markdown fallback)', () {
      expect(buildCoachCard({r'$type': 'weekly-plan', 'data': strategy}), isNull);
      expect(buildCoachCard({
        r'$type': 'race-strategy',
        'data': {'race_name': 'x'},
      }), isNull);
      expect(buildCoachCard(null), isNull);
      expect(buildCoachCard({'no_type': 1}), isNull);
    });
  });

  group('parseLeakedRaceStrategyEnvelope (history self-heal)', () {
    test('bare JSON object', () {
      final wire = parseLeakedRaceStrategyEnvelope(jsonEncode(strategy));
      expect(wire?.type, 'race-strategy');
      expect(wire!.data, isA<Map<String, dynamic>>());
    });

    test('whole ```json fence', () {
      final wire = parseLeakedRaceStrategyEnvelope('```json\n${jsonEncode(strategy)}\n```');
      expect(wire, isNotNull);
    });

    test('tool-direct wrapper {disposition, content}', () {
      final wrapped = jsonEncode({'disposition': 'return_direct', 'content': strategy});
      final wire = parseLeakedRaceStrategyEnvelope(wrapped);
      expect(wire?.data, strategy);
    });

    test('non-JSON / non-object text → null', () {
      expect(parseLeakedRaceStrategyEnvelope('正常回答 **markdown**'), isNull);
      expect(parseLeakedRaceStrategyEnvelope('{broken json'), isNull);
    });

    test('leaked envelope round-trips into a card view', () {
      final wire = parseLeakedRaceStrategyEnvelope(jsonEncode(strategy))!;
      final view = buildCoachCard({r'$type': wire.type, 'data': wire.data});
      expect(view, isNotNull);
    });
  });

  group('looksLikeJsonText (streaming placeholder)', () {
    test('flags leaked envelope prefixes', () {
      expect(looksLikeJsonText('{"race_name"'), isTrue);
      expect(looksLikeJsonText('  {"disposition":'), isTrue);
      expect(looksLikeJsonText('Returning structured response: {'), isTrue);
      expect(looksLikeJsonText('foo "disposition" bar'), isTrue);
      expect(looksLikeJsonText("${'x' * 130}\"disposition\""), isFalse); // 只查前 120 字符
    });

    test('normal markdown passes through', () {
      expect(looksLikeJsonText('## 今日建议\n- 轻松跑'), isFalse);
      expect(looksLikeJsonText(''), isFalse);
    });
  });
}
