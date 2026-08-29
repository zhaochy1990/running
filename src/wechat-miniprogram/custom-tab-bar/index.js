// 自定义底部导航栏 —— 训练 / 记录 / 教练 / 我。
// app.json 里 `tabBar.custom: true` 启用；本组件为底栏唯一渲染源。
// 各 tab 页在 onShow 里调用 `this.getTabBar().setData({ selected: N })` 同步选中态。

Component({
  data: {
    selected: 0,
    list: [
      {
        pagePath: '/pages/index/index',
        text: '训练',
        iconOff: '/assets/icons/tab_today_off.svg',
        iconOn: '/assets/icons/tab_today_on.svg',
      },
      {
        pagePath: '/pages/activities/activities',
        text: '记录',
        iconOff: '/assets/icons/tab_record_off.svg',
        iconOn: '/assets/icons/tab_record_on.svg',
      },
      {
        pagePath: '/pages/coach/coach',
        text: '教练',
        iconOff: '/assets/icons/tab_coach_off.svg',
        iconOn: '/assets/icons/tab_coach_on.svg',
      },
      {
        pagePath: '/pages/profile/profile',
        text: '我',
        iconOff: '/assets/icons/tab_me_off.svg',
        iconOn: '/assets/icons/tab_me_on.svg',
      },
    ],
  },

  methods: {
    switchTab(e) {
      const path = e.currentTarget.dataset.path;
      const index = e.currentTarget.dataset.index;
      if (index === undefined || index === this.data.selected) return;
      wx.switchTab({ url: path });
    },
  },
});
