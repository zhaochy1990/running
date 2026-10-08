// 全局默认分享（#438）：品牌卡，落地首页。除赛事中心/赛事详情/策略三页定制外，
// 其余页面的 onShareAppMessage / onShareTimeline 统一引用这里。
// 首页是 tab 页，路径不能带 query；朋友圈无 path，回落当前页的单页模式。
const DEFAULT_SHARE_TITLE = '砺跑 · 马拉松训练助手';

export function defaultShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
  return { title: DEFAULT_SHARE_TITLE, path: '/pages/index/index' };
}

export function defaultShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent {
  return { title: DEFAULT_SHARE_TITLE };
}
