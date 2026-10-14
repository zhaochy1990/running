import 'package:flutter_test/flutter_test.dart';

import 'package:stride/shared/utils/coord.dart';

void main() {
  test('golden pairs match the TS implementation (utils/coord.ts)', () {
    // 黄金值由 utils/coord.ts 原算法 node 直跑产出（#463 契约）。
    final cases = <List<double>>[
      // 北京
      [116.404, 39.915, 116.41024449916938, 39.91640428150164],
      // 上海
      [121.4737, 31.2304, 121.47822305927693, 31.22845773757727],
      // 太原（马拉松样例区域）
      [112.5584, 37.8734, 112.56467809839938, 37.873906685624625],
      // 曼谷（矩形判定域内 → 仍偏移，与 TS 行为一致）
      [100.0, 13.7563, 100.00085400462878, 13.754896303838542],
    ];
    for (final c in cases) {
      final g = wgs84ToGcj02(c[0], c[1]);
      expect(g.longitude, closeTo(c[2], 1e-9), reason: 'lng ${c[0]}');
      expect(g.latitude, closeTo(c[3], 1e-9), reason: 'lat ${c[1]}');
    }
  });

  test('out-of-China coordinates pass through unchanged', () {
    final g = wgs84ToGcj02(-74.006, 40.7128); // 纽约
    expect(g.longitude, -74.006);
    expect(g.latitude, 40.7128);
  });

  test('in-China offset is in the hundreds-of-meters range', () {
    final g = wgs84ToGcj02(112.5584, 37.8734);
    final dLatM = (g.latitude - 37.8734).abs() * 111320;
    final dLngM =
        (g.longitude - 112.5584).abs() * 111320 * 0.79; // cos(37.9°)
    expect(dLatM, inExclusiveRange(50, 1000));
    expect(dLngM, inExclusiveRange(50, 1000));
  });
}
