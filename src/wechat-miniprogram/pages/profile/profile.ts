import { userStore } from '../../store/index';
import type { UserProfile } from '../../types/api';

Page({
  data: {
    user: null as UserProfile | null,
  },

  onShow() {
    const state = userStore.getState();
    this.setData({ user: state.user });
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      success: (res) => {
        if (res.confirm) {
          userStore.clear();
          wx.reLaunch({ url: '/pages/bind/bind' });
        }
      },
    });
  },
});
