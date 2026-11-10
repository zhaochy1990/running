/**
 * 分享海报地图层（devops#944，方案 B 腾讯静态图，spike 见 docs/spike/map-snapshot/）。
 *
 * 小程序把轨迹按配速分色成 path 组（GCJ-02，utils/coord.ts 转换）+ 起终点
 * markers POST 给后端代理 `/api/users/me/poster/map`——key 只在后端，前端包
 * 不出现。代理未配 key 时返回 503 map_proxy_not_configured，或网络/上游失败
 * 时任何非 2xx：一律 resolve(null)，海报降级为占位地图（矢量轨迹），其余
 * 节正常出图。真图回归挂 devops#949（key 到位后）。
 *
 * 组装逻辑（抽稀 / 分块配色 / 请求体）是纯函数，`node --import
 * ./utils/ts-resolve-hooks.mjs utils/posterMap.check.mts` 自检进 CI。
 */
import { API_BASE_URL, CLIENT_ID, STORAGE_KEYS } from '../constants/config';
import { gradient3 } from './posterGradient';

/** 代理请求体（与 Go internal/tencentlbs.StaticMapRequest 同形）。 */
export interface PosterMapPath {
  color: string;
  weight: number;
  /** [lat, lng] GCJ-02 */
  points: number[][];
}

export interface PosterMapMarker {
  size: 'small' | 'mid';
  color: string;
  lat: number;
  lng: number;
}

export interface PosterMapRequest {
  width: number;
  height: number;
  scale: number;
  paths: PosterMapPath[];
  markers: PosterMapMarker[];
}

/** 带配速的 GCJ 轨迹点（activity-detail buildMapSegments 的产物形状）。 */
export interface TrackPoint {
  latitude: number;
  longitude: number;
  /** s/km，lower = faster；null = 该点无配速 */
  pace: number | null;
}

/** 发给静态图的总点数上限：抽稀到 256 点已平滑（≈40m/点@10km），再翻倍
 * （casing + 分色块）也在 URL 网关限制内从容。 */
export const MAX_TRACK_POINTS = 256;

/** 每个配色块覆盖的抽稀点数：256/8 = 32 条分色 path + 1 条白 casing，
 * 全部落在「≤256 条 / 每条 ≥2 点」的官方限制内。 */
export const PACE_CHUNK = 8;

/** POC 定稿轨迹粗细（px@1080 宽海报）：彩线 13 + 白 casing 19。 */
export const TRACK_WEIGHT = 13;
export const CASING_WEIGHT = 19;

/** 等距抽稀：超出上限时按 stride 取点（首点恒保留，尾点补回防断口）。 */
export function decimateTrack(points: TrackPoint[], max: number): TrackPoint[] {
  if (points.length <= max) return points.slice();
  const stride = Math.ceil(points.length / max);
  const out: TrackPoint[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** '#rrggbb' → '0xrrggbb'（静态图 path color 格式）。 */
export function hexToOx(hex: string): string {
  return `0x${hex.slice(1)}`;
}

/** 组装静态图请求体：白 casing 全轨迹打底 + 按 PACE_CHUNK 分块的配速渐变
 * 彩线（绿慢红红快，gradient3）+ 起绿点/终红点 markers。
 * 返回 null = 轨迹不足以成图（<2 点或无配速极值）。 */
export function buildStaticMapRequest(
  segments: TrackPoint[][],
  width: number,
  height: number,
): PosterMapRequest | null {
  const all = segments.flat();
  if (all.length < 2) return null;
  let paceMin = Infinity;
  let paceMax = -Infinity;
  for (const p of all) {
    if (p.pace != null && p.pace > 0) {
      if (p.pace < paceMin) paceMin = p.pace;
      if (p.pace > paceMax) paceMax = p.pace;
    }
  }
  if (!Number.isFinite(paceMin) || !Number.isFinite(paceMax)) return null;

  const paths: PosterMapPath[] = [];
  let drawnStart: TrackPoint | null = null;
  let drawnEnd: TrackPoint | null = null;

  for (const seg of segments) {
    const decim = decimateTrack(seg, Math.max(2, Math.round((MAX_TRACK_POINTS * seg.length) / all.length)));
    if (decim.length < 2) continue;
    // 白 casing（POC 定稿：19px 白衬底 + 13px 彩线）
    paths.push({
      color: '0xffffff',
      weight: CASING_WEIGHT,
      points: decim.map((p) => [p.latitude, p.longitude]),
    });
    // 配速分色块：chunk 平均配速 → gradient3（绿慢 → 红快）
    const range = paceMax - paceMin;
    for (let i = 0; i < decim.length; i += PACE_CHUNK) {
      const chunk = decim.slice(i, i + PACE_CHUNK);
      if (chunk.length < 2) {
        if (paths.length) {
          const prev = paths[paths.length - 1];
          prev.points.push(...chunk.map((p) => [p.latitude, p.longitude]));
        }
        break;
      }
      let sum = 0;
      let n = 0;
      for (const p of chunk) {
        if (p.pace != null && p.pace > 0) {
          sum += p.pace;
          n++;
        }
      }
      const t = n > 0 && range > 0 ? (paceMax - sum / n) / range : 0;
      paths.push({
        color: hexToOx(gradient3(t)),
        weight: TRACK_WEIGHT,
        points: chunk.map((p) => [p.latitude, p.longitude]),
      });
    }
    if (!drawnStart) drawnStart = decim[0];
    drawnEnd = decim[decim.length - 1];
  }
  if (!paths.length) return null;
  // 起绿点 / 终红点：全局起终点（跨 pause 段），绕圈跑回起点时不重叉。
  const markers: PosterMapMarker[] = [];
  if (drawnStart) markers.push({ size: 'small', color: 'green', lat: drawnStart.latitude, lng: drawnStart.longitude });
  if (drawnEnd && drawnStart && (drawnEnd.latitude !== drawnStart.latitude || drawnEnd.longitude !== drawnStart.longitude)) {
    markers.push({ size: 'small', color: 'red', lat: drawnEnd.latitude, lng: drawnEnd.longitude });
  }
  return { width, height, scale: 2, paths, markers };
}

/** 轨迹 bbox（GCJ 坐标；占位地图层画矢量轨迹用），空轨迹返回 null。 */
export function trackBBox(segments: TrackPoint[][]): { minLat: number; maxLat: number; minLng: number; maxLng: number } | null {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  let n = 0;
  for (const seg of segments) {
    for (const p of seg) {
      n++;
      if (p.latitude < minLat) minLat = p.latitude;
      if (p.latitude > maxLat) maxLat = p.latitude;
      if (p.longitude < minLng) minLng = p.longitude;
      if (p.longitude > maxLng) maxLng = p.longitude;
    }
  }
  if (!n) return null;
  return { minLat, maxLat, minLng, maxLng };
}

/** 拉静态图并落成 canvas 可用的临时文件。任何失败（503 未配 key / 网络 /
 * 写盘）resolve(null)——地图层降级占位，绝不挡海报其余节出图。 */
export function fetchPosterMapImage(body: PosterMapRequest): Promise<string | null> {
  // PNG 临时文件路径（每次覆盖写，同一下载位）。wx 只在函数体内触碰：模块
  // 顶层零副作用，node 自检链可直接 import 本模块。
  const mapTempFile = `${wx.env.USER_DATA_PATH}/poster-map.png`;
  return new Promise((resolve) => {
    // token 直读 storage（services/request 的 getToken 即此实现）：原惰性
    // import('../services/request') 在小程序运行时不 settle，门控修复后
    // 自然路径首次可达即悬挂整张海报（devops#944 修复轮 E2E 发现）。
    const token = (wx.getStorageSync(STORAGE_KEYS.TOKEN) as string) || undefined;
    wx.request({
      url: `${API_BASE_URL}/api/users/me/poster/map`,
      method: 'POST',
      data: body as unknown as Record<string, unknown>,
      header: {
        'Content-Type': 'application/json',
        'X-Client-Id': CLIENT_ID,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      success: (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.warn(`[poster-map] 代理返回 ${res.statusCode}，地图层降级占位`);
          resolve(null);
          return;
        }
        const buf = res.data as ArrayBuffer;
        if (!buf || buf.byteLength < 8) {
          resolve(null);
          return;
        }
        wx.getFileSystemManager().writeFile({
          filePath: mapTempFile,
          data: buf,
          encoding: 'binary',
          success: () => resolve(mapTempFile),
          fail: (err) => {
            console.warn('[poster-map] 写临时文件失败，地图层降级占位', err);
            resolve(null);
          },
        });
      },
      fail: (err) => {
        console.warn('[poster-map] 请求失败，地图层降级占位', err);
        resolve(null);
      },
    } as WechatMiniprogram.RequestOption);
  });
}
