/// WGS84 → GCJ02 坐标偏移（标准 China 偏移算法）。
///
/// 移植自小程序 `utils/coord.ts`（#422 决议：COROS 上报 WGS84 原始 GPS，
/// 高德底图是 GCJ02，不转换轨迹整体偏 ~300-500m）。与 TS 版逐算法对齐，
/// 黄金值单测见 `test/shared/utils/coord_test.dart`。
library;

import 'dart:math' as math;

const double _semiMajor = 6378245.0; // 长半轴
const double _ee = 0.00669342162296594323; // 偏心率平方

class GcjPoint {
  const GcjPoint({required this.latitude, required this.longitude});

  final double latitude;
  final double longitude;
}

bool _outOfChina(double lng, double lat) =>
    lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;

double _transformLat(double x, double y) {
  var ret = -100.0 +
      2.0 * x +
      3.0 * y +
      0.2 * y * y +
      0.1 * x * y +
      0.2 * math.sqrt(x.abs());
  ret += ((20.0 * math.sin(6.0 * x * math.pi) +
              20.0 * math.sin(2.0 * x * math.pi)) *
          2.0) /
      3.0;
  ret += ((20.0 * math.sin(y * math.pi) + 40.0 * math.sin((y / 3.0) * math.pi)) *
          2.0) /
      3.0;
  ret += ((160.0 * math.sin((y / 12.0) * math.pi) +
              320.0 * math.sin((y * math.pi) / 30.0)) *
          2.0) /
      3.0;
  return ret;
}

double _transformLng(double x, double y) {
  var ret =
      300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(x.abs());
  ret += ((20.0 * math.sin(6.0 * x * math.pi) +
              20.0 * math.sin(2.0 * x * math.pi)) *
          2.0) /
      3.0;
  ret += ((20.0 * math.sin(x * math.pi) + 40.0 * math.sin((x / 3.0) * math.pi)) *
          2.0) /
      3.0;
  ret += ((150.0 * math.sin((x / 12.0) * math.pi) +
              300.0 * math.sin((x / 30.0) * math.pi)) *
          2.0) /
      3.0;
  return ret;
}

/// 单一坐标点：WGS84 → GCJ02。境外坐标原样返回（境内才偏移）。
GcjPoint wgs84ToGcj02(double lng, double lat) {
  if (_outOfChina(lng, lat)) return GcjPoint(latitude: lat, longitude: lng);
  var dLat = _transformLat(lng - 105.0, lat - 35.0);
  var dLng = _transformLng(lng - 105.0, lat - 35.0);
  final radLat = (lat / 180.0) * math.pi;
  var magic = math.sin(radLat);
  magic = 1 - _ee * magic * magic;
  final sqrtMagic = math.sqrt(magic);
  dLat =
      (dLat * 180.0) / (((_semiMajor * (1 - _ee)) / (magic * sqrtMagic)) * math.pi);
  dLng =
      (dLng * 180.0) / ((_semiMajor / sqrtMagic) * math.cos(radLat) * math.pi);
  return GcjPoint(latitude: lat + dLat, longitude: lng + dLng);
}
