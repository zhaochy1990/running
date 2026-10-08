// 教练结构化产物通知卡片 —— 聊天气泡里的轻量卡片（比赛策略/赛季训练计划）。
//
// 展示属性（icon/title/subtitle/badge/buttonText/secondaryButtonText）全部由
// utils/coachCards.ts 注册表产出，本组件只负责布局与 tap 冒泡，不感知各产物
// 类型的细节。导航类 CTA 与产物交接（如策略草稿）由聊天页 onCardCta 处理；
// 动作类 CTA（master-plan 启用/放弃）由聊天页直调端点后回写卡片状态。
//
// 事件：
//   open       无 detail  点击卡片主体（不含 CTA 按钮）
//   cta        无 detail  点击主 CTA 按钮
//   secondary  无 detail  点击次级动作按钮

Component({
  properties: {
    /** 卡片图标（assets 路径），空则不渲染。 */
    icon: { type: String, value: '' },
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    /** 角标（如「初稿」）；空则不显示。 */
    badge: { type: String, value: '' },
    /** 主 CTA 按钮文案；空则不渲染按钮。 */
    buttonText: { type: String, value: '' },
    /** 次级动作按钮文案（如 master-plan 的「放弃」）；空则不渲染。 */
    secondaryButtonText: { type: String, value: '' },
  },

  methods: {
    onBodyTap() {
      this.triggerEvent('open');
    },
    onCtaTap() {
      this.triggerEvent('cta');
    },
    onSecondaryTap() {
      this.triggerEvent('secondary');
    },
  },
});
