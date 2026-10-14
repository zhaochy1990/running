/// 轨迹地图数据管线 —— 移植小程序 activity-detail.ts 的地图段构建
/// （#422 决议钉死的渲染参数）。
///
/// 关键修正（勿复刻小程序缺陷）：分段用**共享端点**（步进 MAP_CHUNK-1），
/// 抽稀时补回末点，否则相邻段之间的连接线不绘制（马拉松 stride=19 时
/// ~12.5% 轨迹长度缺失）。所有显示坐标统一经 [wgs84ToGcj02]（单坐标 frame）。
library;

import 'dart:math' as math;
import 'dart:ui' show Color;

import '../../../shared/utils/coord.dart';
import '../models/activity_detail.dart';
import 'lap_marks.dart';

/// 活动内相对三色渐变（慢/低=绿 → 快/高=红）。
const mapGreen = Color(0xFF00a85a);
const mapAmber = Color(0xFFe68a00);
const mapRed = Color(0xFFd32f2f);

/// zones 档位色（曲线/区间条体系，勿与地图三色混用）。
const zoneColors = <Color>[
  Color(0xFF4c8dff),
  Color(0xFF37c85a),
  Color(0xFFf5c542),
  Color(0xFFf5863b),
  Color(0xFFef4444),
  Color(0xFFb45bff),
  Color(0xFF9aa4b2),
];

/// 抽稀上限与分段大小（来自 activity-detail.ts MAX_MAP_PTS / MAP_CHUNK）。
const maxMapPts = 600;
const mapChunk = 8;

/// 有效 GPS 点少于此数不渲染地图。
const minMapPoints = 20;

/// 地图着色模式。
enum MapColoring { none, pace, hr }

/// 一条已转 GCJ02 的轨迹点（pace=s/km，hr=bpm，null 表示该点无值）。
class TrackPoint {
  const TrackPoint({
    required this.latitude,
    required this.longitude,
    this.pace,
    this.hr,
    this.distance,
  });

  final double latitude;
  final double longitude;
  final num? pace;
  final num? hr;
  final num? distance;
}

/// 一段折线（≤8 点、共享端点）+ 该段均值映射的颜色。
class TrackChunk {
  const TrackChunk(this.points, this.color);

  final List<TrackPoint> points;
  final Color color;
}

/// 线性插值两个颜色，t ∈ [0,1]。
Color lerpColor(Color a, Color b, double t) {
  final tt = t.clamp(0.0, 1.0);
  int mix(double from, double to) => ((from + (to - from) * tt) * 255).round();
  return Color.fromARGB(
    (a.a * 255).round(),
    mix(a.r, b.r),
    mix(a.g, b.g),
    mix(a.b, b.b),
  );
}

/// 3 停渐变：绿 → 橙 → 红。活动内相对——同一原始值在两次活动里颜色可不同。
Color gradient3(double t) {
  final tt = t.clamp(0.0, 1.0);
  if (tt < 0.5) return lerpColor(mapGreen, mapAmber, tt * 2);
  return lerpColor(mapAmber, mapRed, (tt - 0.5) * 2);
}

/// 相邻采样点（约 1 点/秒）最大可信位移。超过视为 GPS 漂移坏点
/// （隧道/室内漂到 0,0 或远点会把 bbox 撑爆、画出跨城弦线）。
const maxPlausibleJumpMeters = 500.0;

/// 原始 timeseries 点 → 有效轨迹点（过滤无 GPS 与 GPS 漂移坏点；
/// pace=adjusted_pace??speed，有效域 0<v<1200 s/km）。
/// 坐标在此统一转成 GCJ02（#422：全链单坐标 frame——polyline/徽标/起终点/
/// fit 视角全部用同一份点，禁止混用 WGS84/GCJ）。
List<TrackPoint> toTrackPoints(List<TsPoint> raw) {
  final out = <TrackPoint>[];
  double? lastLat;
  double? lastLon;
  for (final p in raw) {
    if (p.gpsLat == null || p.gpsLon == null) continue;
    final lat = p.gpsLat!.toDouble();
    final lon = p.gpsLon!.toDouble();
    // 坏点：0 坐标 / 境外 / 相对上一有效点跳变超阈值。
    final isZero = lat == 0 && lon == 0;
    final jumped = lastLat != null &&
        _metersBetween(lastLat, lastLon!, lat, lon) > maxPlausibleJumpMeters;
    if (isZero || jumped) {
      // 坏点不进轨迹，也不更新参照点（连续坏点都按同一参照判定）。
      continue;
    }
    lastLat = lat;
    lastLon = lon;
    final paceV = p.adjustedPace ?? p.speed;
    final g = wgs84ToGcj02(lon, lat);
    out.add(
      TrackPoint(
        latitude: g.latitude,
        longitude: g.longitude,
        pace: paceV != null && paceV > 0 && paceV < 1200 ? paceV : null,
        hr: p.hr != null && p.hr! > 0 ? p.hr : null,
        distance: p.distance,
      ),
    );
  }
  return out;
}

double _metersBetween(double lat1, double lon1, double lat2, double lon2) {
  final dLat = (lat2 - lat1) * 111320.0;
  final dLon = (lon2 - lon1) * 111320.0 * math.cos(lat1 * math.pi / 180.0);
  return math.sqrt(dLat * dLat + dLon * dLon);
}

/// 抽稀（等距取模 + 补末点）并按共享端点切成 ≤[mapChunk] 点的段，逐段着色。
///
/// 无效（<[minMapPoints] 点）返回空列表。返回 null 表示当前 [coloring] 模式
/// 下没有任何有效 metric（如选了配速但全程无配速值），调用方回退无色模式。
List<TrackChunk>? buildTrackChunks(List<TrackPoint> pts, MapColoring coloring) {
  if (pts.length < minMapPoints) return const [];

  // 抽稀：stride = ceil(n/600) 等距取模；末点必须保留（补末点）。
  final stride = pts.length > maxMapPts ? (pts.length / maxMapPts).ceil() : 1;
  final decim = <TrackPoint>[
    for (var i = 0; i < pts.length; i += stride) pts[i],
    if ((pts.length - 1) % stride != 0) pts.last,
  ];

  num? paceMin, paceMax, hrMin, hrMax;
  for (final p in decim) {
    final v = coloring == MapColoring.pace ? p.pace : p.hr;
    if (v == null) continue;
    if (coloring == MapColoring.pace) {
      paceMin = paceMin == null || v < paceMin ? v : paceMin;
      paceMax = paceMax == null || v > paceMax ? v : paceMax;
    } else if (coloring == MapColoring.hr) {
      hrMin = hrMin == null || v < hrMin ? v : hrMin;
      hrMax = hrMax == null || v > hrMax ? v : hrMax;
    }
  }
  final hasMetric = coloring == MapColoring.none ||
      (coloring == MapColoring.pace
          ? paceMin != null && paceMax! > paceMin
          : hrMin != null && hrMax! > hrMin);
  if (!hasMetric) return null;

  final chunks = <TrackChunk>[];
  // 共享端点分段：步进 MAP_CHUNK-1，段间连接线不缺。
  for (var i = 0; i < decim.length - 1; i += mapChunk - 1) {
    final end = math.min(i + mapChunk, decim.length);
    final chunk = decim.sublist(i, end);
    if (chunk.length < 2) break;
    chunks.add(
      TrackChunk(chunk, _chunkColor(chunk, coloring, paceMin, paceMax, hrMin, hrMax)),
    );
  }
  return chunks;
}

Color _chunkColor(
  List<TrackPoint> chunk,
  MapColoring coloring,
  num? paceMin,
  num? paceMax,
  num? hrMin,
  num? hrMax,
) {
  if (coloring == MapColoring.none) return mapGreen;
  var sum = 0.0;
  var n = 0;
  for (final p in chunk) {
    final v = coloring == MapColoring.pace ? p.pace : p.hr;
    if (v != null && v > 0) {
      sum += v;
      n++;
    }
  }
  if (n == 0) return mapGreen;
  final avg = sum / n;
  // 配速：慢（大 s/km）→ 绿，快（小 s/km）→ 红（与 HR 反向）。
  if (coloring == MapColoring.pace) {
    final t = paceMax! > paceMin! ? (paceMax - avg) / (paceMax - paceMin) : 0.0;
    return gradient3(t.toDouble());
  }
  final t = hrMax! > hrMin! ? (avg - hrMin) / (hrMax - hrMin) : 0.0;
  return gradient3(t.toDouble());
}

/// fit 视野：bbox 四周扩 max(跨度×0.1, 0.0008°)。输入/输出均为 GCJ02。
({GcjPoint sw, GcjPoint ne}) trackFitBounds(List<TrackPoint> pts) {
  var minLat = double.infinity, maxLat = -double.infinity;
  var minLng = double.infinity, maxLng = -double.infinity;
  for (final p in pts) {
    if (p.latitude < minLat) minLat = p.latitude;
    if (p.latitude > maxLat) maxLat = p.latitude;
    if (p.longitude < minLng) minLng = p.longitude;
    if (p.longitude > maxLng) maxLng = p.longitude;
  }
  double pad(double span) => math.max(span * 0.1, 0.0008);
  return (
    sw: GcjPoint(latitude: minLat - pad(maxLat - minLat), longitude: minLng - pad(maxLng - minLng)),
    ne: GcjPoint(latitude: maxLat + pad(maxLat - minLat), longitude: maxLng + pad(maxLng - minLng)),
  );
}

/// 圈徽标位置：把每圈结束边界按「累计圈距占总圈距的比例」映射到 timeseries
/// 点（避开 timeseries.distance 与 segment.distance_m 的单位差异）。恢复圈
/// 不计号不打点。坐标 GCJ02（[toTrackPoints] 已统一转换）。
List<({int lapNo, GcjPoint pos})> lapBadgePositions(
  List<LapV2> segments,
  List<TrackPoint> pts,
) {
  if (pts.length < 2 || segments.isEmpty) return const [];
  final totalTs = (pts.last.distance ?? 0) - (pts.first.distance ?? 0);
  final totalLap = segments.fold<num>(0, (s, x) => s + x.distanceM);
  if (totalTs <= 0 || totalLap <= 0) return const [];

  final marks = lapMarks(segments);
  final out = <({int lapNo, GcjPoint pos})>[];
  var cum = 0.0;
  var lapNo = 0;
  var cursor = 0;
  for (var i = 0; i < segments.length; i++) {
    cum += segments[i].distanceM;
    if (marks[i].rest) continue;
    lapNo += 1;
    final target = (pts.first.distance ?? 0) + (cum / totalLap) * totalTs;
    while (cursor < pts.length - 1 && (pts[cursor].distance ?? 0) < target) {
      cursor++;
    }
    out.add((lapNo: lapNo, pos: GcjPoint(latitude: pts[cursor].latitude, longitude: pts[cursor].longitude)));
  }
  return out;
}
