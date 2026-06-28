import 'package:flutter_test/flutter_test.dart';
import 'package:stride/features_v2/activity/utils/pace_format.dart';

void main() {
  group('parsePaceFmt', () {
    test('parses apostrophe pace format (m\'ss"/km)', () {
      expect(parsePaceFmt('5\'18"/km'), 318);
      expect(parsePaceFmt('4\'05"'), 245);
    });

    test('parses colon pace format (m:ss)', () {
      expect(parsePaceFmt('5:18'), 318);
    });

    test('parses prime separator (U+2032)', () {
      expect(parsePaceFmt('5′18"'), 318);
    });

    test('returns null when no m:ss pattern is present', () {
      expect(parsePaceFmt('--'), isNull);
      expect(parsePaceFmt(''), isNull);
      expect(parsePaceFmt('N/A'), isNull);
    });
  });

  group('fmtPaceSeconds', () {
    test('formats seconds-per-km as m\'ss"', () {
      expect(fmtPaceSeconds(318), '5\'18"');
      expect(fmtPaceSeconds(600), '10\'00"');
    });

    test('zero-pads the seconds component', () {
      expect(fmtPaceSeconds(245), '4\'05"');
    });
  });

  test('parse → format round-trips', () {
    for (final secs in [180, 245, 318, 600]) {
      expect(parsePaceFmt(fmtPaceSeconds(secs)), secs);
    }
  });
}
