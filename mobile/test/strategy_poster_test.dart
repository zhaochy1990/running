// 策略海报绘制与截图管线自检：CustomPaint 出图非空白、尺寸符合
// #420 决议（600×(360+rows×56)，dpr2 像素翻倍）。
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/race/widgets/strategy_poster.dart';

Future<Uint8List?> _capturePng(GlobalKey key) async {
  final ctx = key.currentContext;
  if (ctx == null) return null;
  final boundary = ctx.findRenderObject()! as RenderRepaintBoundary;
  final image = await boundary.toImage(pixelRatio: 2);
  final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
  return bytes?.buffer.asUint8List();
}

void main() {
  testWidgets('海报 RepaintBoundary 出图：尺寸 + 非空白 PNG', (tester) async {
    final key = GlobalKey();
    await tester.pumpWidget(
      Center(
        child: RepaintBoundary(
          key: key,
          child: StrategyPosterCard(
            data: StrategyPosterData(
              dateLabel: '2026-12-06',
              itemLabel: '全马',
              raceName: '2026上海马拉松',
              target: '2:55:00',
              rows: const [
                ('0–5km 起跑热身', '4:55/km', '24:35'),
                ('5–21km 巡航段', '4:43/km', '1:40:52'),
                ('38–42.195km 冲刺', '4:30/km', '2:55:00'),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 布局尺寸：600 宽 × (360+3×56) 高。
    final ro = key.currentContext!.findRenderObject()! as RenderBox;
    expect(ro.size.width, 600);
    expect(ro.size.height, 360 + 3 * 56);

    Uint8List? bytes;
    await tester.binding.runAsync(() async {
      bytes = await _capturePng(key);
    });
    expect(bytes, isNotNull);
    // dpr2：宽 1200；非空白（空白图压缩后仅数百字节）。
    expect(bytes!.length, greaterThan(5 * 1024));
  });
}
