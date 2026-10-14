/// 策略配速卡海报 —— #420 决议钉死的 canvas 布局：600×(360+rows×56) dpr2、
/// 深底 #0a0a0b + 顶 6px #d8ff3e、目标 56 bold、行距 44、页脚 STRIDE · 比赛策略。
/// 分享/保存 = RepaintBoundary 截图 → PNG → share_plus 系统分享 / Gal 存相册
/// （stride-devops#424 决议 v1：海报图片 + 系统分享，免微信 SDK 资质）。
library;

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:gal/gal.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../../core/theme/app_typography.dart';

class StrategyPosterData {
  const StrategyPosterData({
    required this.dateLabel, // '2026-10-18'
    required this.itemLabel, // '全程'
    required this.raceName,
    required this.target, // '3:15:00'
    required this.rows, // (segment, pace, cumulative)
  });

  final String dateLabel;
  final String itemLabel;
  final String raceName;
  final String target;
  final List<(String, String, String)> rows;
}

class StrategyPosterCard extends StatelessWidget {
  const StrategyPosterCard({super.key, required this.data});

  final StrategyPosterData data;

  @override
  Widget build(BuildContext context) {
    final h = 360.0 + data.rows.length * 56;
    return CustomPaint(
      size: Size(600, h),
      painter: _PosterPainter(data: data, height: h),
    );
  }
}

class _PosterPainter extends CustomPainter {
  _PosterPainter({required this.data, required this.height});

  final StrategyPosterData data;
  final double height;

  static const _bg = Color(0xFF0A0A0B);
  static const _lime = Color(0xFFD8FF3E);
  static const _gray = Color(0xFF9C9C9D);
  static const _rowFg = Color(0xFFF2F2F3);
  static const _rowDim = Color(0xFFB9B9BC);
  static const _foot = Color(0xFF6A6A6E);

  void _text(Canvas canvas, String text, double x, double y,
      {required double size,
      required Color color,
      bool bold = false,
      String? family}) {
    final tp = TextPainter(
      text: TextSpan(
        text: text,
        style: TextStyle(
          fontFamily: family ?? AppTypography.fontSans,
          fontSize: size,
          fontWeight: bold ? FontWeight.w700 : FontWeight.w400,
          color: color,
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    tp.paint(canvas, Offset(x, y - tp.height)); // canvas fillText 的 y 是基线
  }

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = _bg);
    canvas.drawRect(const Offset(0, 0) & Size(size.width, 6),
        Paint()..color = _lime);

    _text(canvas, '${data.dateLabel} · ${data.itemLabel}', 36, 60, size: 20, color: _gray);
    _text(canvas, data.raceName, 36, 106, size: 34, color: Colors.white, bold: true);
    _text(canvas, '目标成绩', 36, 160, size: 20, color: _gray);
    _text(canvas, data.target, 36, 220, size: 56, color: _lime, bold: true);

    _text(canvas, '分段', 36, 276, size: 22, color: _gray);
    _text(canvas, '配速', 250, 276, size: 22, color: _gray);
    _text(canvas, '累计', 410, 276, size: 22, color: _gray);
    canvas.drawLine(
      const Offset(36, 288),
      Offset(size.width - 36, 288),
      Paint()
        ..color = Colors.white.withValues(alpha: 0.2)
        ..strokeWidth = 1,
    );

    var y = 332.0;
    for (final (segment, pace, cumulative) in data.rows) {
      _text(canvas, _clip(segment, 14), 36, y, size: 22, color: _rowFg);
      _text(canvas, pace, 250, y, size: 22, color: _rowFg);
      _text(canvas, cumulative, 410, y, size: 22, color: _rowDim);
      y += 44;
    }
    _text(canvas, 'STRIDE · 比赛策略', 36, height - 28, size: 18, color: _foot);
  }

  String _clip(String s, int max) =>
      s.characters.length <= max ? s : '${s.characters.take(max)}';

  @override
  bool shouldRepaint(covariant _PosterPainter old) => old.data != data;
}

/// 截图 [boundary] 为 PNG 并写入临时目录，返回文件路径。
Future<String> savePosterPng(GlobalKey boundaryKey, String fileName) async {
  final ctx = boundaryKey.currentContext;
  if (ctx == null) throw StateError('poster not mounted');
  final boundary = ctx.findRenderObject()! as RenderRepaintBoundary;
  final ui.Image image = await boundary.toImage(pixelRatio: 2);
  final bytes =
      (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
  final dir = await getTemporaryDirectory();
  final file = File('${dir.path}/$fileName');
  await file.writeAsBytes(bytes);
  return file.path;
}

/// 生成海报 → 系统分享面板（微信对话/朋友圈/任意渠道通吃）。
Future<void> shareStrategyPoster(GlobalKey boundaryKey, String fileName) async {
  final path = await savePosterPng(boundaryKey, fileName);
  await SharePlus.instance.share(
    ShareParams(
      files: [XFile(path, mimeType: 'image/png')],
      subject: 'STRIDE 比赛策略',
    ),
  );
}

/// 生成海报 → 保存到系统相册（相册仅新增权限；iOS 首次保存由系统自动弹
/// 授权，拒绝时 Gal 抛 accessDenied → 上层提示，不静默丢图）。
/// 不显式调 Gal.requestAccess：它会在未授权时等待原生弹窗回调，集成测试/
/// 自动化场景下无人应答会永久阻塞；putImage 直写同样会触发系统授权。
Future<void> saveStrategyPosterToGallery(
  GlobalKey boundaryKey,
  String fileName,
) async {
  final path = await savePosterPng(boundaryKey, fileName);
  await Gal.putImage(path);
}
