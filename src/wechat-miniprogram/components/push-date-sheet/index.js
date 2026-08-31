// 推送日期选择底部弹层 —— 用于选择将计划 session 推送到手表的目标日期。
//
// 取代 wx.showActionSheet：后者 itemList 上限 6 项，无法承载 ±7 天共 15 个选项，
// 超过上限会走 fail 回调被 `.catch(() => null)` 吞掉，用户点按钮「没反应」（见 PR #430）。
// 这里用可滚动的自定义底部弹层展示全部日期选项。
//
// 事件：
//   bindselect  detail = { value: string /* YYYY-MM-DD */ }   选中某个日期
//   bindclose  无 detail                                       取消 / 点遮罩关闭

Component({
  properties: {
    /** 是否显示弹层 */
    show: { type: Boolean, value: false },
    /** 日期选项 [{ label, value }]，由 utils/date.buildPushDateOptions 生成 */
    options: { type: Array, value: [] },
    /** 弹层标题 */
    title: { type: String, value: '选择推送日期' },
  },

  methods: {
    // 选中某个日期，向父级抛 select 事件（detail.value = YYYY-MM-DD）
    onSelect(e) {
      const value = e.currentTarget.dataset.value;
      if (!value) return;
      this.triggerEvent('select', { value });
    },

    // 取消 / 点击遮罩关闭
    onClose() {
      this.triggerEvent('close');
    },

    // 空操作：阻止遮罩滚动穿透 & 阻止点击弹层内容时触发遮罩关闭
    noop() {},
  },
});
