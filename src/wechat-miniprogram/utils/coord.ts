// WGS84 → GCJ02 坐标偏移（标准 China 偏移算法，无需依赖）。

// COROS 上报的是 WGS84（原始 GPS），而腾讯/高德地图渲染的是 GCJ02（火星坐标）。
// 跳过这一步在境内会让轨迹整体偏差约 300-500m —— 与 Web 端使用 gcoord 的结论一致。

export interface GcjPoint {
  latitude: number;
  longitude: number;
}

const SEMI_MAJOR = 6378245.0; // 长半轴
const EE = 0.00669342162296594323; // 偏心率平方
const PI = Math.PI;

function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320.0 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/** 单一坐标点：WGS84 → GCJ02。境外坐标原样返回（境内才偏移）。 */
export function wgs84ToGcj02(lng: number, lat: number): GcjPoint {
  if (outOfChina(lng, lat)) return { latitude: lat, longitude: lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((SEMI_MAJOR * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((SEMI_MAJOR / sqrtMagic) * Math.cos(radLat) * PI);
  return { latitude: lat + dLat, longitude: lng + dLng };
}
