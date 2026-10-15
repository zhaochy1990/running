/// TrackMapCard — 活动详情 GPS 轨迹地图（flutter_amap_plus / 高德）。
///
/// 渲染参数按 #422 决议钉死：≤600 点抽稀补末点、共享端点 8 点/段分段、
/// 三色 gradient3 活动内相对、起终点（重合不画终点）/圈徽标、天气浮层压
/// 地图左上、地图高 56vh。力量活动（sport_type 402/800）不渲染。
library;

import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_amap_plus/flutter_amap_plus.dart';

import '../../../core/env/env.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/theme/tokens.dart';
import '../../../shared/utils/coord.dart';
import '../models/activity_detail.dart';
import '../utils/track.dart';

/// 每次启动只初始化一次 SDK。合规（#417 决议）：隐私同意 = 登录页协议勾选
/// （地图页只能登录后到达，勾选必然发生在 init 之前）。
Future<void>? _sdkInit;

Future<void> _ensureSdkInit() {
  // 失败不缓存：下次进入地图页重试（如首冷启动无网）。
  return _sdkInit ??= AMapWidget.init(
    // iOS key 已配（Env.amapIosKey 默认值）；iOS 模拟器因 SDK 无 arm64-sim
    // 切片仍无法渲染底图，真机可验（#570 记录）。
    apiKey: ApiKey(iosKey: Env.amapIosKey, androidKey: Env.amapAndroidKey),
    agreePrivacy: true,
  ).catchError((_) => _sdkInit = null);
}

class TrackMapCard extends StatefulWidget {
  const TrackMapCard({super.key, required this.detail});

  final ActivityDetailV2 detail;

  @override
  State<TrackMapCard> createState() => _TrackMapCardState();
}

class _TrackMapCardState extends State<TrackMapCard> {
  MapColoring _coloring = MapColoring.pace;

  @override
  Widget build(BuildContext context) {
    final act = widget.detail.activity;
    if (act.isStrength) return const SizedBox.shrink();

    final pts = toTrackPoints(widget.detail.timeseries);
    if (pts.length < minMapPoints) {
      return _MapShell(
        coloring: _coloring,
        onColoring: (c) => setState(() => _coloring = c),
        child: const _MapPlaceholder('暂无轨迹数据'),
      );
    }

    final chunks = buildTrackChunks(pts, _coloring) ??
        // 当前模式无有效 metric（如选配速但全程无配速）→ 回退无色。
        buildTrackChunks(pts, MapColoring.none)!;

    // pts 已在 toTrackPoints 统一转 GCJ02，polyline/徽标/fit 同 frame。
    final gcjPts = [
      for (final p in pts) GcjPoint(latitude: p.latitude, longitude: p.longitude),
    ];
    final bounds = trackFitBounds(pts);
    final sw = bounds.sw;
    final ne = bounds.ne;

    return _MapShell(
      coloring: _coloring,
      onColoring: (c) => setState(() => _coloring = c),
      weather: _weatherRow(act),
      child: FutureBuilder<void>(
        future: _ensureSdkInit(),
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return const _MapPlaceholder('地图加载中…');
          }
          return FutureBuilder<Set<Marker>>(
            future: _buildMarkers(pts, gcjPts),
            builder: (context, markersSnap) {
              return ClipRRect(
                borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
                child: AMapWidget(
                  mapOptions: AMapMapOptions(
                    initFitPositions: [
                      Position(latitude: sw.latitude, longitude: sw.longitude),
                      Position(latitude: ne.latitude, longitude: ne.longitude),
                    ],
                  ),
                  polylines: _polylines(chunks),
                  markers: markersSnap.data ?? const {},
                ),
              );
            },
          );
        },
      ),
    );
  }

  Set<Polyline> _polylines(List<TrackChunk> chunks) {
    if (_coloring == MapColoring.none) {
      // 无色模式：整条一条 #00a85a width 5。
      return {
        Polyline(
          id: 'track',
          points: [
            for (final c in chunks)
              for (final p in c.points)
                Position(latitude: p.latitude, longitude: p.longitude),
          ],
          color: const Color(0xFF00a85a),
          width: 5,
        ),
      };
    }
    return {
      for (var i = 0; i < chunks.length; i++)
        Polyline(
          id: 'track-$i',
          points: [
            for (final p in chunks[i].points)
              Position(latitude: p.latitude, longitude: p.longitude),
          ],
          color: chunks[i].color,
          width: 5,
        ),
    };
  }

  /// 起终点（重合不画终点）+ 圈徽标。位图异步渲染（文字徽标需画到 PNG）。
  Future<Set<Marker>> _buildMarkers(
    List<TrackPoint> pts,
    List<GcjPoint> gcjPts,
  ) async {
    final markers = <Marker>{};
    final start = gcjPts.first;
    final end = gcjPts.last;

    final startBmp = await _dotPng(const Color(0xFF00a85a));
    markers.add(Marker(
      id: 'start',
      position: Position(latitude: start.latitude, longitude: start.longitude),
      bitmap: Bitmap(bytes: startBmp, size: Size(width: 20, height: 20)),
      anchor: Anchor(x: 0.5, y: 0.5),
      zIndex: 1,
    ));
    // 绕圈跑回起点时终点与起点重合，不重叉。
    if (start.latitude != end.latitude || start.longitude != end.longitude) {
      final endBmp = await _dotPng(const Color(0xFFd32f2f));
      markers.add(Marker(
        id: 'end',
        position: Position(latitude: end.latitude, longitude: end.longitude),
        bitmap: Bitmap(bytes: endBmp, size: Size(width: 20, height: 20)),
        anchor: Anchor(x: 0.5, y: 0.5),
        zIndex: 1,
      ));
    }

    final badges = lapBadgePositions(widget.detail.segments, pts);
    for (final b in badges) {
      markers.add(Marker(
        id: 'lap-${b.lapNo}',
        position: Position(latitude: b.pos.latitude, longitude: b.pos.longitude),
        bitmap: Bitmap(bytes: await _badgePng('${b.lapNo}'), size: Size(width: 20, height: 20)),
        anchor: Anchor(x: 0.5, y: 0.5),
        zIndex: 100 + b.lapNo.toDouble(),
      ));
    }
    return markers;
  }

  /// 天气浮层内容：温度（+体感）/湿度/风速（>0 才显示）。
  Widget _weatherRow(ActivityV2 act) {
    final items = <String>[];
    if (act.temperature != null) {
      var v = '${act.temperature}°C';
      if (act.feelsLike != null && act.feelsLike != act.temperature) {
        v += '（体感 ${act.feelsLike}°）';
      }
      items.add(v);
    }
    if (act.humidity != null) items.add('${act.humidity}%');
    if (act.windSpeed != null && act.windSpeed! > 0) {
      items.add('${act.windSpeed} km/h');
    }
    if (items.isEmpty) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceSm,
        vertical: StrideTokens.spaceXs,
      ),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
      ),
      child: Text(
        items.join('  '),
        style: const TextStyle(
          fontFamily: AppTypography.fontMono,
          fontSize: StrideTokens.fs11,
          color: StrideTokens.fg,
        ),
      ),
    );
  }
}

/// 地图卡片外壳：56vh 地图 + 着色切换 + 天气浮层。
class _MapShell extends StatelessWidget {
  const _MapShell({
    required this.coloring,
    required this.onColoring,
    required this.child,
    this.weather,
  });

  final MapColoring coloring;
  final ValueChanged<MapColoring> onColoring;
  final Widget child;
  final Widget? weather;

  @override
  Widget build(BuildContext context) {
    final mapHeight = MediaQuery.sizeOf(context).height * 0.56;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Stack(
          children: [
            SizedBox(height: mapHeight, width: double.infinity, child: child),
            if (weather != null)
              Positioned(
                top: StrideTokens.spaceSm,
                left: StrideTokens.spaceSm,
                child: weather!,
              ),
          ],
        ),
        const SizedBox(height: StrideTokens.spaceSm),
        Row(
          children: [
            for (final (label, mode) in const [
              ('无色', MapColoring.none),
              ('配速', MapColoring.pace),
              ('心率', MapColoring.hr),
            ]) ...[
              ChoiceChip(
                label: Text(label),
                selected: coloring == mode,
                onSelected: (_) => onColoring(mode),
                labelStyle: const TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs12,
                ),
                visualDensity: VisualDensity.compact,
              ),
              const SizedBox(width: StrideTokens.spaceSm),
            ],
          ],
        ),
      ],
    );
  }
}

class _MapPlaceholder extends StatelessWidget {
  const _MapPlaceholder(this.message);

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: StrideTokens.grid,
      alignment: Alignment.center,
      child: Text(
        message,
        style: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs13,
          color: StrideTokens.muted,
        ),
      ),
    );
  }
}

/// 纯色圆点 PNG（起/终点），2x 渲染保证清晰。
Future<Uint8List> _dotPng(Color color) async {
  return _png(20, 20, (canvas) {
    canvas.drawCircle(
      const Offset(10, 10),
      7,
      Paint()
        ..color = color
        ..style = PaintingStyle.fill,
    );
    canvas.drawCircle(
      const Offset(10, 10),
      7,
      Paint()
        ..color = Colors.white
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
  });
}

/// 圈号徽标 PNG：白字 / #0b3d24 底 / #00e676 边 1px / 圆角 20 / padding 2。
Future<Uint8List> _badgePng(String label) async {
  return _png(20, 20, (canvas) {
    const rect = Rect.fromLTWH(1, 1, 18, 18);
    final paint = Paint()
      ..color = const Color(0xFF0b3d24)
      ..style = PaintingStyle.fill;
    canvas.drawRRect(
      RRect.fromRectAndRadius(rect, const Radius.circular(20)),
      paint,
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(rect, const Radius.circular(20)),
      Paint()
        ..color = const Color(0xFF00e676)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1,
    );
    final tp = TextPainter(
      text: TextSpan(
        text: label,
        style: TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: label.length > 1 ? 11 : 13,
          fontWeight: FontWeight.w700,
          color: Colors.white,
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    tp.paint(
      canvas,
      Offset((20 - tp.width) / 2, (20 - tp.height) / 2),
    );
  });
}

Future<Uint8List> _png(int w, int h, void Function(Canvas) draw) async {
  final rec = ui.PictureRecorder();
  draw(Canvas(rec)..scale(2));
  final image = await rec.endRecording().toImage(w * 2, h * 2);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  return data!.buffer.asUint8List();
}
