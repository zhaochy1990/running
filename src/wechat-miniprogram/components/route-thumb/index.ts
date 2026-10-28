// 轨迹缩略图（devops#827）—— offscreen canvas 矢量绘制组件。
//
// 输入：shape = 后端 route_thumb（[[x,y],...] 归一折线，空数组 = 无 GPS）、
// size = 显示尺寸（rpx）、icon = 无 GPS / 绘制失败时的运动图标 fallback、
// labelId = 导图缓存键成分。绘制流程：wx.createOffscreenCanvas(2d) 画折线
// （圆角 joins/caps、线宽≈尺寸/30、墨色 theme.routeInk 令牌）→
// wx.canvasToTempFilePath 导出临时图 → <image> 展示。列表挂真 canvas 节点太重
// （每行一个节点），导图 + 缓存后纯 image 展示是标准做法，快速滚动零 canvas。
//
// 缓存（模块级 Map，key=labelId+墨色值）：主题令牌一变 key 即变，自动失效
// 重绘；同一活动（下拉刷新 / 换页回来）命中后不再画。墨色值来自
// utils/theme.ts 单源，theme.check.mts 对账 wxss 镜像。

import {
  fitRoutePoints,
  LINE_WIDTH_RATIO,
  parseRouteShape,
  routeThumbCacheKey,
} from '../../utils/routeThumb';
import { theme } from '../../utils/theme';

interface RouteThumbData {
  /** 导出的临时图路径；空串 = 尚未就绪或失败，走 icon fallback。 */
  thumbPath: string;
}

/** 组件属性定义（Component 第二泛型收窄 this.properties 的值类型）。 */
type RouteThumbProps = {
  shape: { type: ArrayConstructor; value: unknown[] };
  size: { type: NumberConstructor; value: number };
  icon: { type: StringConstructor; value: string };
  labelId: { type: StringConstructor; value: string };
};

/** 实例字段（非渲染数据）：挂在 this 上避免模块级状态多实例串扰。 */
interface RouteThumbInstance {
  /** 组件已销毁：导图异步回调回来时跳过 setData，避免报错。 */
  _detached: boolean;
  /** 当前在画的缓存键（含空串 = 无在画任务）：attached 与首次 observer 可能
   * 双触发，用它去重；shape 变更换键后，旧键的迟到回调凭它作废。 */
  _inflightKey: string;
}

type RouteThumbMethods = {
  renderThumb(): void;
  draw(shape: number[][], cacheKey: string): void;
};

/** offscreen canvas 2d 上下文的最小结构（同 workout-detail CoverCtx 的做法，避免 any）。 */
interface OffscreenCtx2d {
  strokeStyle: string;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

/** wx.createOffscreenCanvas({type:'2d'}) 返回的离屏画布（typings 旧签名在前，收窄用）。 */
interface OffscreenCanvas2d {
  width: number;
  height: number;
  getContext(type: '2d'): OffscreenCtx2d;
}

/** 导图缓存：key = `${labelId}|${墨色}` → 临时图路径。 */
const thumbCache = new Map<string, string>();
/** 缓存上限：长列表翻页防无界增长，超限按插入序淘汰最旧（命中不提升，够用且简单）。 */
const CACHE_MAX = 300;
/** 出图倍率：72rpx ≈ 36css px，×3 导图保证高分屏不发虚。 */
const EXPORT_SCALE = 3;

function rpxToPx(rpx: number): number {
  try {
    const win = wx.getWindowInfo();
    return (rpx * (win.windowWidth || 375)) / 750;
  } catch {
    return (rpx * 375) / 750;
  }
}

Component<RouteThumbData, RouteThumbProps, RouteThumbMethods, [], RouteThumbInstance>({
  properties: {
    // 空数组 = 无 GPS / 未算（页面侧 route_thumb ?? [] 归一），fallback 口径
    // 与今天 thumb_url 缺失一致。
    shape: { type: Array, value: [] },
    /** 方形缩略图显示尺寸（rpx）。 */
    size: { type: Number, value: 72 },
    /** fallback 运动图标路径。 */
    icon: { type: String, value: '' },
    /** 活动 label_id（缓存键成分）。 */
    labelId: { type: String, value: '' },
  },

  data: {
    thumbPath: '',
  },

  lifetimes: {
    attached() {
      this._detached = false;
      this._inflightKey = '';
      this.renderThumb();
    },
    detached() {
      this._detached = true;
    },
  },

  observers: {
    // 下拉刷新 / 加载更多会整体重设行数据；shape 变了按新折线重画（命中缓存则纯换图）。
    shape() {
      this.renderThumb();
    },
  },

  methods: {
    renderThumb() {
      const shape = parseRouteShape(this.properties.shape);
      if (!shape) {
        this._inflightKey = '';
        this.setData({ thumbPath: '' });
        return;
      }
      const key = routeThumbCacheKey(this.properties.labelId, theme.routeInk);
      const cached = thumbCache.get(key);
      if (cached) {
        this._inflightKey = '';
        this.setData({ thumbPath: cached });
        return;
      }
      // attached 与首次 observer 可能双触发同一次渲染，同一键只画一次。
      if (this._inflightKey === key) return;
      this._inflightKey = key;
      this.draw(shape, key);
    },

    draw(shape: number[][], cacheKey: string) {
      const px = Math.max(8, Math.round(rpxToPx(this.properties.size)));
      const canvasSize = px * EXPORT_SCALE;
      let canvas: OffscreenCanvas2d;
      try {
        canvas = wx.createOffscreenCanvas({
          type: '2d',
          width: canvasSize,
          height: canvasSize,
        }) as unknown as OffscreenCanvas2d;
      } catch {
        // 环境异常（基础库过旧等）：走 icon fallback，不阻断列表。
        if (this._inflightKey === cacheKey) this._inflightKey = '';
        this.setData({ thumbPath: '' });
        return;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        // 旧基础库按旧签名把入参当宽高，拿不到 2d 上下文：同样 fallback。
        if (this._inflightKey === cacheKey) this._inflightKey = '';
        this.setData({ thumbPath: '' });
        return;
      }
      const points = fitRoutePoints(shape, canvasSize);
      ctx.strokeStyle = theme.routeInk;
      ctx.lineWidth = canvasSize * LINE_WIDTH_RATIO;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
      }
      ctx.stroke();
      wx.canvasToTempFilePath({
        canvas: canvas as unknown as WechatMiniprogram.Canvas,
        fileType: 'png',
        destWidth: canvasSize,
        destHeight: canvasSize,
        success: (out) => {
          if (this._detached || this._inflightKey !== cacheKey) return;
          this._inflightKey = '';
          if (thumbCache.size >= CACHE_MAX) {
            thumbCache.delete(thumbCache.keys().next().value as string);
          }
          thumbCache.set(cacheKey, out.tempFilePath);
          this.setData({ thumbPath: out.tempFilePath });
        },
        fail: () => {
          // 导图失败同 fallback（口径与今天 thumb_url 加载失败一致）。
          // 清掉在画键，让后续重设（下拉刷新）还有机会重试。
          if (this._detached || this._inflightKey !== cacheKey) return;
          this._inflightKey = '';
          this.setData({ thumbPath: '' });
        },
      });
    },
  },
});
