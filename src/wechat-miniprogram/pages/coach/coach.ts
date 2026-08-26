import { sendCoachChatMessage } from '../../services/coach';

interface CoachMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

interface CoachPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  messages: CoachMessage[];
  input: string;
  sending: boolean;
  scrollIntoId: string;
}

interface CoachPageHandlers {
  onInput(e: WechatMiniprogram.Input): void;
  onSend(): Promise<void>;
  onMenuTap(): void;
}

let seq = 0;

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

function contentPaddingTopRpx(): number {
  let statusPx = statusBarHeight();
  let width = 375;
  try {
    const win = wx.getWindowInfo();
    statusPx = win.statusBarHeight;
    width = win.windowWidth || 375;
  } catch {
    const sys = wx.getSystemInfoSync();
    statusPx = sys.statusBarHeight;
    width = sys.windowWidth || 375;
  }
  return Math.round((statusPx * 750) / width) + 128 + 24;
}

function welcomeMessages(): CoachMessage[] {
  return [
    {
      id: ++seq,
      role: 'assistant',
      content:
        '你好，我是你的 AI 教练。可以问我今天的训练安排、疲劳状态、配速建议，或复盘某次训练。',
    },
  ];
}

Page<CoachPageData, CoachPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    messages: welcomeMessages(),
    input: '',
    sending: false,
    scrollIntoId: '',
  },

  onLoad() {
    const msgs = this.data.messages;
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
      scrollIntoId: `msg-${msgs[msgs.length - 1].id}`,
    });
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 3 });
    }
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ input: e.detail.value });
  },

  async onSend() {
    const text = this.data.input.trim();
    if (!text || this.data.sending) return;

    const userMsg: CoachMessage = { id: ++seq, role: 'user', content: text };
    this.setData({
      messages: [...this.data.messages, userMsg],
      input: '',
      sending: true,
      scrollIntoId: `msg-${userMsg.id}`,
    });

    let reply = '收到。让我结合你的近期训练和身体状态，再给你具体建议。';
    try {
      const res = await sendCoachChatMessage(text);
      const content = res.assistant_message?.content;
      if (content && content.trim()) reply = content.trim();
    } catch {
      // 后端不可用时保留默认回复，保证可预览。
    }

    const assistantMsg: CoachMessage = { id: ++seq, role: 'assistant', content: reply };
    this.setData({
      messages: [...this.data.messages, assistantMsg],
      sending: false,
      scrollIntoId: `msg-${assistantMsg.id}`,
    });
  },

  onMenuTap() {
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },
});
