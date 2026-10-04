// 教练结构化产物通知卡片 —— 聊天气泡里的轻量卡片（比赛策略/赛季训练计划）。
//
// 展示属性（icon/title/subtitle/badge/buttonText）全部由 utils/coachCards.ts
// 注册表产出，本组件只负责布局与 tap 冒泡（bindopen），不感知各产物类型的
// 细节；导航与产物交接（如策略草稿）由聊天页 onCardOpen 处理。
//
// 事件：
//   bindopen  无 detail  点击卡片任意区域（含 CTA 按钮）

Component({
  properties: {
    /** 卡片图标（assets 路径），空则不渲染。 */
    icon: { type: String, value: '' },
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    /** 角标（如「初稿」）；空则不显示。 */
    badge: { type: String, value: '' },
    /** CTA 按钮文案；空则不渲染按钮（如 master-plan 的启用/放弃还没接入）。 */
    buttonText: { type: String, value: '' },
  },

  methods: {
    onTap() {
      this.triggerEvent('open');
    },
  },
});
