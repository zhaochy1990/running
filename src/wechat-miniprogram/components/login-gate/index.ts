// 登录引导空态组件：标题/副标题/图标可配，点「去登录」向页面抛 login 事件，
// 由页面决定 redirect（utils/authGate.openLogin）。样式跟随页面浅色主题。
Component({
  properties: {
    title: { type: String, value: '登录后查看' },
    subtitle: { type: String, value: '' },
    icon: { type: String, value: '/assets/icons/sprint.svg' },
  },

  methods: {
    onTap() {
      this.triggerEvent('login');
    },
  },
});
