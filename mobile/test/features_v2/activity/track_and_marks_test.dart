import 'dart:ui' show Color;

import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/activity/models/activity_detail.dart';
import 'package:stride/features_v2/activity/utils/lap_marks.dart';
import 'package:stride/features_v2/activity/utils/strength_groups.dart';
import 'package:stride/features_v2/activity/utils/track.dart';
import 'package:stride/shared/utils/coord.dart';

TsPoint _pt({double? lat, double? lon, num? hr, num? pace, num? dist}) =>
    TsPoint(
      gpsLat: lat,
      gpsLon: lon,
      hr: hr,
      adjustedPace: pace,
      distance: dist,
    );

List<TsPoint> _synthetic(int n, {double distStep = 10}) => [
      for (var i = 0; i < n; i++)
        TsPoint(
          gpsLat: 37.87 + i * 0.0001,
          gpsLon: 112.55 + i * 0.0001,
          hr: 120 + i % 60,
          adjustedPace: 240.0 + (i % 120),
          distance: i * distStep,
        ),
    ];

void main() {
  group('toTrackPoints', () {
    test('drops points without GPS and bounds pace to (0,1200)', () {
      final pts = toTrackPoints([
        _pt(lat: 37.87, lon: 112.55, pace: 300, dist: 0),
        _pt(hr: 150, pace: 300, dist: 10), // 无 GPS
        _pt(lat: 37.8701, lon: 112.55, pace: 5000, dist: 20), // pace 越界
        _pt(lat: 37.8702, lon: 112.55, hr: 0, dist: 30), // hr=0 无效
      ]);
      expect(pts.length, 3);
      expect(pts[1].pace, isNull);
      expect(pts[2].pace, isNull);
      expect(pts[2].hr, isNull);
      // 输出统一 GCJ02：与输入 WGS84 不同（境内偏移数百米量级）。
      expect(pts[0].longitude, isNot(112.55));
    });
  });

  group('toTrackPoints GPS 漂移过滤', () {
    test('drops zero-coordinate outliers and far jumps', () {
      final pts = toTrackPoints([
        _pt(lat: 37.87, lon: 112.55, pace: 300, dist: 0),
        // 漂到 0,0（隧道坏点）。
        _pt(lat: 0, lon: 0, pace: 300, dist: 10),
        _pt(lat: 37.8701, lon: 112.55, pace: 300, dist: 20), // ~11m 正常
        // 远跳坏点（>500m）。
        _pt(lat: 38.90, lon: 113.55, pace: 300, dist: 30),
        _pt(lat: 37.8702, lon: 112.55, pace: 300, dist: 40), // 参照仍是上个有效点
      ]);
      expect(pts.length, 3);
      // GCJ 偏移单调一致：相邻点仍按 ~11m 递增。
      expect(pts[2].latitude, greaterThan(pts[1].latitude));
      expect(pts[1].latitude, greaterThan(pts[0].latitude));
    });
  });

  group('buildTrackChunks（勿复刻小程序漏接缺陷）', () {
    test('chunks share endpoints — no gap between adjacent chunks', () {
      final chunks = buildTrackChunks(
        toTrackPoints(_synthetic(300)),
        MapColoring.pace,
      )!;
      expect(chunks.length, greaterThan(1));
      for (var i = 1; i < chunks.length; i++) {
        final prevLast = chunks[i - 1].points.last;
        final curFirst = chunks[i].points.first;
        expect(curFirst.latitude, prevLast.latitude);
        expect(curFirst.longitude, prevLast.longitude);
      }
      // 每段 ≤ MAP_CHUNK 点。
      for (final c in chunks) {
        expect(c.points.length, lessThanOrEqualTo(mapChunk));
        expect(c.points.length, greaterThanOrEqualTo(2));
      }
    });

    test('decimation keeps the last point（抽稀补末点）', () {
      // 1500 点 → stride=3 → 500 取模点，末点 i=1499 不在取模序列里。
      final raw = _synthetic(1500);
      final chunks = buildTrackChunks(
        toTrackPoints(raw),
        MapColoring.none,
      )!;
      final all = chunks
          .expand((c) => c.points)
          .map((p) => p.longitude)
          .toList();
      // 点已统一转 GCJ02，末点期望值同样转换。
      final wgsLast = raw.last;
      final want = wgs84ToGcj02(
        wgsLast.gpsLon!.toDouble(),
        wgsLast.gpsLat!.toDouble(),
      );
      expect(all.last, closeTo(want.longitude, 1e-9));
    });

    test('<20 valid points renders nothing', () {
      expect(
        buildTrackChunks(toTrackPoints(_synthetic(19)), MapColoring.pace),
        isEmpty,
      );
      expect(
        buildTrackChunks(toTrackPoints(_synthetic(20)), MapColoring.pace),
        isNotEmpty,
      );
    });

    test('pace coloring: slow=green, fast=red（活动内相对）', () {
      // 点 0-99 pace 600（慢），点 100-199 pace 240（快）。
      final pts = toTrackPoints([
        for (var i = 0; i < 100; i++)
          TsPoint(
            gpsLat: 37.87 + i * 0.001,
            gpsLon: 112.55,
            adjustedPace: 600,
            distance: i * 10.0,
          ),
        for (var i = 100; i < 200; i++)
          TsPoint(
            gpsLat: 37.87 + i * 0.001,
            gpsLon: 112.55,
            adjustedPace: 240,
            distance: i * 10.0,
          ),
      ]);
      final chunks = buildTrackChunks(pts, MapColoring.pace)!;
      expect(chunks.first.color, const Color(0xFF00a85a)); // 最慢 → 绿
      expect(chunks.last.color, const Color(0xFFd32f2f)); // 最快 → 红
    });

    test('hr coloring: low=green, high=red', () {
      final pts = toTrackPoints([
        for (var i = 0; i < 100; i++)
          TsPoint(
            gpsLat: 37.87 + i * 0.001,
            gpsLon: 112.55,
            hr: 100,
            distance: i * 10.0,
          ),
        for (var i = 100; i < 200; i++)
          TsPoint(
            gpsLat: 37.87 + i * 0.001,
            gpsLon: 112.55,
            hr: 180,
            distance: i * 10.0,
          ),
      ]);
      final chunks = buildTrackChunks(pts, MapColoring.hr)!;
      expect(chunks.first.color, const Color(0xFF00a85a));
      expect(chunks.last.color, const Color(0xFFd32f2f));
    });

    test('selected coloring without any metric falls back (null)', () {
      final pts = toTrackPoints(_synthetic(100));
      final noPace = [
        for (final p in pts) _pt(lat: p.latitude, lon: p.longitude),
      ];
      expect(buildTrackChunks(toTrackPoints(noPace), MapColoring.pace), isNull);
    });
  });

  group('lapBadgePositions', () {
    test('maps cumulative lap distance onto timeseries proportionally', () {
      // 100 点，每点 10m，总 990m。两圈各 500m。
      final pts = toTrackPoints(_synthetic(100));
      final segments = [
        const LapV2(
          lapIndex: 0,
          distanceKm: 0.5,
          distanceM: 500,
          durationS: 100,
          durationFmt: '1:40',
          paceFmt: "5'20\"",
        ),
        const LapV2(
          lapIndex: 1,
          distanceKm: 0.5,
          distanceM: 500,
          durationS: 100,
          durationFmt: '1:40',
          paceFmt: "5'20\"",
        ),
      ];
      final badges = lapBadgePositions(segments, pts);
      expect(badges.length, 2);
      expect(badges[0].lapNo, 1);
      expect(badges[1].lapNo, 2);
      // 徽标与轨迹同一 GCJ frame：直接等于对应 timeseries 点。
      expect(badges[0].pos.latitude, closeTo(pts[50].latitude, 1e-9));
      expect(badges[0].pos.longitude, closeTo(pts[50].longitude, 1e-9));
      expect(badges[1].pos.latitude, closeTo(pts.last.latitude, 1e-9));
    });

    test('rest laps get no badge and occupy no lap number', () {
      final pts = toTrackPoints(_synthetic(100));
      final segments = [
        const LapV2(
          lapIndex: 0,
          distanceKm: 0.5,
          distanceM: 500,
          durationS: 100,
          durationFmt: '1:40',
          paceFmt: "5'20\"",
        ),
        const LapV2(
          lapIndex: 1,
          segName: '恢复',
          mode: 3,
          distanceKm: 0.5,
          distanceM: 490,
          durationS: 100,
          durationFmt: '1:40',
          paceFmt: "5'20\"",
        ),
      ];
      final badges = lapBadgePositions(segments, pts);
      expect(badges.length, 1);
      expect(badges.single.lapNo, 1);
    });
  });

  group('lapMarks（逐圈最快/最慢/恢复标记）', () {
    LapV2 lap(int i, {num? pace, int? hr, String name = '', int? mode}) =>
        LapV2(
          lapIndex: i,
          distanceKm: 1,
          distanceM: 1000,
          durationS: 300,
          durationFmt: '5:00',
          paceFmt: "5'00\"",
          segName: name,
          mode: mode,
          avgPace: pace,
          avgHr: hr,
        );

    test('rest laps: mode 3 or 恢复/休息 names, and skip lap numbers', () {
      final marks = lapMarks([
        lap(0, pace: 300),
        lap(1, pace: 310, name: '恢复'),
        lap(2, pace: 320, mode: 3),
        lap(3, pace: 330, name: '休息'),
        lap(4, pace: 280),
      ]);
      expect(marks[1].rest, isTrue);
      expect(marks[2].rest, isTrue);
      expect(marks[3].rest, isTrue);
      expect(marks[0].rest, isFalse);
      // 非恢复圈之间趋势跨过恢复圈比较：第 4 圈 vs 第 0 圈（280<300 → up）。
      expect(marks[4].trend, Trend.up);
    });

    test('fastest/slowest tagged only with >=3 paced laps and distinct paces',
        () {
      final two = lapMarks([lap(0, pace: 300), lap(1, pace: 320)]);
      expect(two.any((m) => m.fastest || m.slowest), isFalse);

      final three = lapMarks([lap(0, pace: 320), lap(1, pace: 300), lap(2, pace: 340)]);
      expect(three[1].fastest, isTrue);
      expect(three[2].slowest, isTrue);
      expect(three[0].fastest, isFalse);

      final equal = lapMarks([lap(0, pace: 300), lap(1, pace: 300), lap(2, pace: 300)]);
      expect(equal.any((m) => m.fastest || m.slowest), isFalse);
    });

    test('hr trend direction across rest laps', () {
      final marks = lapMarks([
        lap(0, pace: 300, hr: 140),
        lap(1, pace: 310, name: '恢复'),
        lap(2, pace: 320, hr: 155),
      ]);
      expect(marks[2].hrTrend, Trend.up);
    });
  });

  group('buildStrengthGroups（力量分组）', () {
    LapV2 seg(String name, {int? mode, int? hr, num dur = 60}) => LapV2(
          lapIndex: 0,
          distanceKm: 0,
          distanceM: 0,
          durationS: dur,
          durationFmt: '1:00',
          paceFmt: '',
          segName: name,
          mode: mode,
          avgHr: hr,
        );

    test('merges consecutive same-name segments, skips rest modes', () {
      final groups = buildStrengthGroups([
        seg('深蹲', hr: 120),
        seg('深蹲', hr: 130),
        seg('休息', mode: 15),
        seg('卧推', hr: 140),
      ]);
      expect(groups.length, 2);
      expect(groups[0].name, '深蹲');
      expect(groups[0].sets, 2);
      expect(groups[0].avgHr, 125);
      expect(groups[1].name, '卧推');
      expect(groups[1].sets, 1);
    });

    test('same name re-appearing later forms a new group', () {
      final groups = buildStrengthGroups([
        seg('深蹲'),
        seg('卧推'),
        seg('深蹲'),
      ]);
      expect(groups.map((g) => g.name), ['深蹲', '卧推', '深蹲']);
    });

    test('rest modes 15/16/17 skipped（与恢复圈 mode 3 口径不同）', () {
      final groups = buildStrengthGroups([
        seg('硬拉'),
        seg('组间', mode: 16),
        seg('组间', mode: 17),
      ]);
      expect(groups.length, 1);
      expect(groups.single.name, '硬拉');
    });
  });
}
