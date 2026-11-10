// Spike stride-devops#943：验证方案 A（mp 原生 <map> + MapContext.snapshot()）三验证点。
// V1 截图 API 是否存在、输出是否含 polyline；V2 includePoints 缩放/中心是否确定可控；
// V3 地图离屏（仍渲染）时上述能力是否保持。结果写入 data.results，由 miniprogram-automator
// 采集（docs/spike/map-snapshot/ 下证据 + 结论报告）。
//
// 轨迹用合成 GCJ-02 椭圆环线（世纪公园附近），不依赖任何后端数据。

interface SpikeResult {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'info';
  detail: string;
}

interface LatLng {
  latitude: number;
  longitude: number;
}

interface Region {
  southwest: LatLng;
  northeast: LatLng;
}

interface MapPolylineLite {
  points: LatLng[];
  color: string;
  width: number;
  arrowLine?: boolean;
}

interface MapMarkerLite {
  id: number;
  latitude: number;
  longitude: number;
  iconPath: string;
  width?: number;
  height?: number;
}

// MapContext.snapshot 在官方类型定义（miniprogram-api-typings 5.2.2+，API 同步基础库 3.17.0）
// 中不存在，运行时用鸭子类型探测，不引入自定义类型声明。
interface SnapshotCapableContext {
  snapshot?: (option: {
    success?: (res: { tempImagePath?: string }) => void;
    fail?: (err: { errMsg?: string }) => void;
  }) => void;
}

const TRACK_CENTER = { latitude: 31.2206, longitude: 121.5494 }; // 世纪公园（GCJ-02）
const TRACK_RX = 0.006;
const TRACK_RY = 0.004;

function buildTrack(): LatLng[] {
  const pts: LatLng[] = [];
  const start = Math.PI * 0.06; // 开口环线：起点≠终点，起终点标记可分辨
  const end = Math.PI * 1.94;
  const steps = 72;
  for (let i = 0; i <= steps; i++) {
    const t = start + ((end - start) * i) / steps;
    pts.push({
      latitude: TRACK_CENTER.latitude + TRACK_RY * Math.sin(t),
      longitude: TRACK_CENTER.longitude + TRACK_RX * Math.cos(t),
    });
  }
  return pts;
}

function trackBBox(pts: LatLng[]): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of pts) {
    minLat = Math.min(minLat, p.latitude);
    maxLat = Math.max(maxLat, p.latitude);
    minLng = Math.min(minLng, p.longitude);
    maxLng = Math.max(maxLng, p.longitude);
  }
  return { minLat, maxLat, minLng, maxLng };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Page({
  data: {
    center: TRACK_CENTER,
    polylines: [] as MapPolylineLite[],
    markers: [] as MapMarkerLite[],
    fitPoints: [] as LatLng[],
    results: [] as SpikeResult[],
  },

  onLoad() {
    const track = buildTrack();
    const bbox = trackBBox(track);
    const padLat = (bbox.maxLat - bbox.minLat) * 0.15;
    const padLng = (bbox.maxLng - bbox.minLng) * 0.15;
    this.setData({
      polylines: [
        { points: track, color: '#FF6363FF', width: 8, arrowLine: true },
      ],
      markers: [
        { id: 1, latitude: track[0].latitude, longitude: track[0].longitude, iconPath: '/assets/icons/map_dot.png', width: 16, height: 16 },
        { id: 2, latitude: track[track.length - 1].latitude, longitude: track[track.length - 1].longitude, iconPath: '/assets/icons/map_dot.png', width: 16, height: 16 },
      ],
      fitPoints: [
        { latitude: bbox.minLat - padLat, longitude: bbox.minLng - padLng },
        { latitude: bbox.maxLat + padLat, longitude: bbox.maxLng + padLng },
      ],
    });
    this.runVerifications(track).catch((err: unknown) => {
      this.push({
        id: 'V0',
        name: '跑批异常',
        status: 'fail',
        detail: String(err),
      });
    });
  },

  push(r: SpikeResult) {
    this.setData({ results: [...this.data.results, r] });
  },

  async runVerifications(track: LatLng[]) {
    // ---- V0 环境 ----
    let sdkVersion = 'unknown';
    try {
      sdkVersion = wx.getAppBaseInfo().SDKVersion;
    } catch {
      sdkVersion = (wx.getSystemInfoSync().SDKVersion as string | undefined) ?? 'unknown';
    }
    const skyInfoSync = (wx as unknown as { getSkylineInfoSync?: () => Record<string, unknown> }).getSkylineInfoSync;
    const skyline = typeof skyInfoSync === 'function' ? JSON.stringify(skyInfoSync.call(wx)) : 'API 不存在（webview 渲染）';
    this.push({
      id: 'V0',
      name: '环境',
      status: 'info',
      detail: `基础库 ${sdkVersion}；平台 ${wx.getDeviceInfo().platform}；skyline: ${skyline}`,
    });

    const ctx = wx.createMapContext('onScreenMap');
    const ctxOff = wx.createMapContext('offscreenMap');

    // ---- V1：截图 API 存在性（含 polyline 的前提是 API 先存在） ----
    const snapCtx = ctx as unknown as SnapshotCapableContext;
    const protoChain: string[] = [];
    let proto = Object.getPrototypeOf(ctx);
    while (proto) {
      protoChain.push(...Object.getOwnPropertyNames(proto));
      proto = Object.getPrototypeOf(proto);
    }
    const instanceKeys = Object.keys(ctx as unknown as Record<string, unknown>);
    const hasSnapshot = typeof snapCtx.snapshot === 'function';
    this.push({
      id: 'V1a',
      name: 'MapContext.snapshot 存在性',
      status: hasSnapshot ? 'pass' : 'fail',
      detail:
        `typeof ctx.snapshot = ${typeof snapCtx.snapshot}；` +
        `wx.canIUse('MapContext.snapshot') = ${wx.canIUse('MapContext.snapshot')}；` +
        `wx.canIUse('Snapshot.takeSnapshot') = ${wx.canIUse('Snapshot.takeSnapshot')}；` +
        `MapContext 原型链方法: ${protoChain.length ? protoChain.join(',') : '(空)'}；` +
        `实例自有键: ${instanceKeys.length ? instanceKeys.join(',') : '(空)'}`,
    });

    if (hasSnapshot) {
      const r = await this.callSnapshot(snapCtx);
      this.push({
        id: 'V1b',
        name: 'snapshot 调用（在屏，验证含 polyline）',
        status: r.ok ? 'pass' : 'fail',
        detail: r.detail,
      });
    }

    // ---- V2：includePoints 缩放/中心确定性 ----
    const bbox = trackBBox(track);
    const fitPts: LatLng[] = [
      { latitude: bbox.minLat, longitude: bbox.minLng },
      { latitude: bbox.maxLat, longitude: bbox.maxLng },
    ];
    const padding = [20, 20, 20, 20];

    const run1 = await this.fitAndReadRegion(ctx, fitPts, padding);
    const run2 = await this.fitAndReadRegion(ctx, fitPts, padding);
    if (!run1 || !run2) {
      this.push({ id: 'V2', name: 'includePoints 确定性', status: 'fail', detail: 'getRegion 读取失败' });
    } else {
      const stable = regionKey(run1) === regionKey(run2);
      const contains =
        run1.southwest.latitude <= bbox.minLat &&
        run1.northeast.latitude >= bbox.maxLat &&
        run1.southwest.longitude <= bbox.minLng &&
        run1.northeast.longitude >= bbox.maxLng;
      const status: SpikeResult['status'] = stable && contains ? 'pass' : 'fail';
      this.push({
        id: 'V2',
        name: 'includePoints 缩放/中心确定性（禁交互下重复 fit）',
        status,
        detail:
          `两次 fit 后 region 一致: ${stable}；region 包含轨迹 bbox: ${contains}；` +
          `run1 ${formatRegion(run1)}；run2 ${formatRegion(run2)}；目标 bbox lat ${bbox.minLat.toFixed(5)}~${bbox.maxLat.toFixed(5)} lng ${bbox.minLng.toFixed(5)}~${bbox.maxLng.toFixed(5)}`,
      });
    }

    // ---- V3：离屏（fixed 移出屏幕，仍渲染） ----
    const offRegion = await this.fitAndReadRegion(ctxOff, fitPts, padding);
    let offDetail = `离屏 includePoints+getRegion: ${offRegion ? `成功 ${formatRegion(offRegion)}` : '失败'}`;
    let offOk = offRegion !== null;
    if (hasSnapshot) {
      const offSnap = await this.callSnapshot(ctxOff as unknown as SnapshotCapableContext);
      offDetail += `；离屏 snapshot: ${offSnap.detail}`;
      offOk = offOk && offSnap.ok;
    } else {
      offDetail += '；离屏 snapshot: N/A（V1a 已证 API 不存在）';
    }
    this.push({ id: 'V3', name: '离屏地图可行性（仍渲染）', status: offOk ? 'pass' : 'fail', detail: offDetail });

    // ---- 汇总 ----
    this.push({
      id: 'SUM',
      name: '方案 A 结论',
      status: hasSnapshot ? 'pass' : 'fail',
      detail: hasSnapshot
        ? 'snapshot API 存在，按 V1b/V3 证据评估'
        : 'MapContext.snapshot API 不存在（typings 5.2.3/基础库 3.17.0 亦无此 API，运行时证实）→ 方案 A 前提不成立，退方案 B（腾讯静态图 API）',
    });
  },

  async callSnapshot(ctx: SnapshotCapableContext): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      ctx.snapshot?.({
        success: (res) => {
          const path = res.tempImagePath ?? '(无 tempImagePath)';
          resolve({ ok: true, detail: `成功 tempImagePath=${path}（是否含 polyline 需人工/截图核对）` });
        },
        fail: (err) => resolve({ ok: false, detail: `fail errMsg=${err.errMsg ?? '(空)'}` }),
      });
    });
  },

  // includePoints 后轮询 getRegion 至连续两次读数稳定（地图动画结束的判定），
  // 再读一次作为结果；返回 null 表示读取失败。
  async fitAndReadRegion(ctx: WechatMiniprogram.MapContext, points: LatLng[], padding: number[]): Promise<Region | null> {
    await new Promise<void>((resolve) => {
      ctx.includePoints({
        points,
        padding,
        complete: () => resolve(),
      });
    });
    let last = '';
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const r = await this.readRegion(ctx);
      if (r) {
        const key = regionKey(r);
        if (key === last) return r;
        last = key;
      }
    }
    const final = await this.readRegion(ctx);
    return final;
  },

  readRegion(ctx: WechatMiniprogram.MapContext): Promise<Region | null> {
    return new Promise((resolve) => {
      ctx.getRegion({
        success: (res) => resolve({ southwest: res.southwest, northeast: res.northeast }),
        fail: () => resolve(null),
      });
    });
  },
});

function regionKey(r: Region): string {
  return `${r.southwest.latitude.toFixed(6)},${r.southwest.longitude.toFixed(6)},${r.northeast.latitude.toFixed(6)},${r.northeast.longitude.toFixed(6)}`;
}

function formatRegion(r: Region): string {
  return `SW(${r.southwest.latitude.toFixed(5)},${r.southwest.longitude.toFixed(5)}) NE(${r.northeast.latitude.toFixed(5)},${r.northeast.longitude.toFixed(5)})`;
}
