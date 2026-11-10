// posterMap.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/posterMap.check.mts`。
// 覆盖抽稀 / 配速分块组装 / casing+markers 语义 / bbox；wx 触碰函数
// （fetchPosterMapImage）不在此断言（node 无 wx），import 本身即「顶层零副作用」断言。
import {
  buildStaticMapRequest,
  decimateTrack,
  hexToOx,
  MAX_TRACK_POINTS,
  PACE_CHUNK,
  trackBBox,
  type TrackPoint,
} from './posterMap.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// ── decimateTrack：超限抽稀、首点恒留、尾点补回 ──
{
  const mk = (n: number): TrackPoint[] =>
    Array.from({ length: n }, (_, i) => ({ latitude: 31 + i * 0.0001, longitude: 121 + i * 0.0001, pace: 300 + i }));
  eq(decimateTrack(mk(10), 20).length, 10, 'decimate under cap is identity');
  const out = decimateTrack(mk(1000), 256);
  if (out.length > 260) throw new Error(`decimate over cap: ${out.length}`);
  eq(out[0].latitude, mk(1000)[0].latitude, 'first point kept');
  eq(out[out.length - 1].latitude, mk(1000)[999].latitude, 'last point appended back');
}

// ── hexToOx ──
eq(hexToOx('#00a85a'), '0x00a85a', 'hex to 0x');

// ── buildStaticMapRequest：结构 / casing / 分色 / 起终点 markers ──
{
  // 单段 100 点、配速 240~360 递增（越走越慢 → 色彩从红回绿）
  const seg: TrackPoint[] = Array.from({ length: 100 }, (_, i) => ({
    latitude: 31.2 + i * 0.0001,
    longitude: 121.5 + i * 0.0001,
    pace: 240 + i * 1.2,
  }));
  const req = buildStaticMapRequest([seg], 492, 260);
  if (!req) throw new Error('request should build');
  eq(req.scale, 2, 'scale 2');
  eq(req.width, 492, 'width');
  eq(req.height, 260, 'height');
  const casing = req.paths[0];
  eq(casing.color, '0xffffff', 'casing is white');
  eq(casing.weight, 19, 'casing weight 19');
  eq(casing.points.length, 100, 'casing covers all decimated points');
  const colored = req.paths.slice(1);
  if (colored.length !== Math.ceil(100 / PACE_CHUNK)) throw new Error(`chunk count ${colored.length}`);
  for (const p of colored) {
    if (p.weight !== 13) throw new Error('colored weight 13');
    if (!/^0x[0-9a-f]{6}$/.test(p.color)) throw new Error(`color format ${p.color}`);
    if (p.points.length < 2) throw new Error('each colored path >= 2 points');
  }
  if (colored.length > 255) throw new Error('path count within 256 total');
  // 慢段（后段 pace 大 → t 小 → 偏绿 #00a85a 系），快段（前段 → 偏红）
  const firstColor = colored[0].color;
  const lastColor = colored[colored.length - 1].color;
  const gFast = parseInt(firstColor.slice(3, 5), 16);
  const gSlow = parseInt(lastColor.slice(3, 5), 16);
  if (gFast >= gSlow) {
    throw new Error(`fast chunk should be redder than slow: ${firstColor} vs ${lastColor}`);
  }
  // 起绿点终红点
  eq(req.markers.length, 2, 'start+end markers');
  eq(req.markers[0].color, 'green', 'start green');
  eq(req.markers[1].color, 'red', 'end red');
  eq(req.markers[0].lat, seg[0].latitude, 'marker at first point');

  // 环线（终点=起点）：只 1 个 marker，不重叉
  const loop: TrackPoint[] = seg.map((p, i) => (i === 99 ? { ...seg[0], pace: p.pace } : p));
  const reqLoop = buildStaticMapRequest([loop], 492, 260);
  eq(reqLoop ? reqLoop.markers.length : 0, 1, 'loop track: single marker');

  // 多段（pause 切开）：每段都有自己的 casing；markers 只取全局起终点（恰好 2 个）
  const two = buildStaticMapRequest([seg.slice(0, 50), seg.slice(50)], 492, 260);
  if (!two) throw new Error('two-segment request should build');
  const casings = two.paths.filter((p) => p.color === '0xffffff');
  eq(casings.length, 2, 'casing per pause segment');
  eq(two.markers.length, 2, 'exactly global start+end markers across pause segments');
  eq(two.markers[0].lat, seg[0].latitude, 'global start');
  eq(two.markers[1].color, 'red', 'global end red');
  eq(two.markers[1].lat, seg[99].latitude, 'global end');

  // 数据不足：<2 点 / 无配速 → null
  eq(buildStaticMapRequest([seg.slice(0, 1)], 492, 260), null, 'single point → null');
  const noPace: TrackPoint[] = seg.map((p) => ({ ...p, pace: null }));
  eq(buildStaticMapRequest([noPace], 492, 260), null, 'no pace → null');

  // 抽稀上限：300 点单段 → casing ≤ MAX_TRACK_POINTS
  const big = buildStaticMapRequest(
    [Array.from({ length: 3000 }, (_, i) => ({ latitude: 31.2 + i * 1e-5, longitude: 121.5 + i * 1e-5, pace: 300 }))],
    492,
    260,
  );
  if (!big) throw new Error('big request should build');
  if (big.paths[0].points.length > MAX_TRACK_POINTS + 2) throw new Error(`casing decimated: ${big.paths[0].points.length}`);
}

// ── trackBBox ──
eq(trackBBox([]), null, 'empty bbox null');
{
  const bbox = trackBBox([[{ latitude: 31.2, longitude: 121.5, pace: 300 }, { latitude: 31.3, longitude: 121.6, pace: 300 }]]);
  eq(bbox, { minLat: 31.2, maxLat: 31.3, minLng: 121.5, maxLng: 121.6 }, 'bbox');
}

console.log('posterMap.check: all assertions passed');
