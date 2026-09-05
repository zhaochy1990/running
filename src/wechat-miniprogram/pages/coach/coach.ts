import { sendCoachChatMessage, fetchCoachHistory, type CoachHistoryMessage } from '../../services/coach';
import { markdownToHtml } from '../../utils/markdown';

interface CoachMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  // assistant 消息渲染用（GFM→HTML，经 <mp-html> 渲染）；user 消息保持纯文本。
  html?: string;
  // user 消息：本轮 client_turn_id（重试时复用）；failed 表示发送失败需重试。
  clientTurnId?: string;
  failed?: boolean;
}

interface CoachPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  messages: CoachMessage[];
  input: string;
  sending: boolean;
  scrollIntoId: string;
  // mp-html 样式：容器兜底颜色/字重 + 结构化 tag 样式（深色主题）。
  containerStyle: string;
  tagStyle: Record<string, string>;
}

interface CoachPageHandlers {
  onInput(e: WechatMiniprogram.Input): void;
  onSend(): Promise<void>;
  onRetry(e: WechatMiniprogram.TouchEvent): void;
  onMenuTap(): void;
}

let seq = 0;
let turnSeq = 0;
function nextClientTurnId(): string {
  return `mini-${Date.now()}-${++turnSeq}`;
}
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
  const content =
    '你好，我是你的 AI 教练。可以问我今天的训练安排、疲劳状态、配速建议，或复盘某次训练。';
  return [{ id: ++seq, role: 'assistant', content, html: markdownToHtml(content) }];
}

function toCoachMessage(m: CoachHistoryMessage): CoachMessage {
  const msg: CoachMessage = {
    id: ++seq,
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  };
  if (m.role === 'assistant') msg.html = markdownToHtml(m.content);
  return msg;
}

Page<CoachPageData, CoachPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    messages: welcomeMessages(),
    input: '',
    sending: false,
    scrollIntoId: '',
    containerStyle: 'color:#e3e2e5;font-size:13px;line-height:20px;',
    tagStyle: {
      p: 'margin:0 0 10px;color:#e3e2e5;',
      ul: 'margin:0 0 10px;padding-left:20px;color:#e3e2e5;',
      ol: 'margin:0 0 10px;padding-left:20px;color:#e3e2e5;',
      li: 'margin:0 0 4px;color:#e3e2e5;',
      h1: 'margin:10px 0 6px;color:#e3e2e5;',
      h2: 'margin:10px 0 6px;color:#e3e2e5;',
      h3: 'margin:10px 0 6px;color:#e3e2e5;',
      h4: 'margin:10px 0 6px;color:#e3e2e5;font-weight:600;',
      h5: 'margin:10px 0 6px;color:#e3e2e5;font-weight:600;',
      h6: 'margin:10px 0 6px;color:#e3e2e5;font-weight:600;',
      blockquote:
        'margin:0 0 10px;padding-left:10px;border-left:3px solid rgba(255,255,255,0.18);color:#b8b8bc;',
      pre: 'margin:0 0 10px;padding:10px;background:#25262a;border-radius:8px;overflow-x:auto;color:#e3e2e5;',
      code: 'font-family:monospace;background:rgba(255,255,255,0.08);border-radius:4px;padding:0 4px;color:#e3e2e5;',
      a: 'color:#ffb3af;',
    },
  },

  async onLoad() {
    let msgs = this.data.messages;
    try {
      const history = await fetchCoachHistory();
      if (history && Array.isArray(history.messages) && history.messages.length) {
        seq = 0;
        msgs = history.messages.map(toCoachMessage);
      }
    } catch {
      // 历史拉取失败（后端未配置/网络异常）时保留欢迎语。
    }
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
      messages: msgs,
      scrollIntoId: `msg-${msgs[msgs.length - 1].id}`,
    });
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 2 });
    }
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ input: e.detail.value });
  },

  async onSend() {
    const text = this.data.input.trim();
    if (!text || this.data.sending) return;

    const clientTurnId = nextClientTurnId();
    const userMsg: CoachMessage = { id: ++seq, role: 'user', content: text, clientTurnId };
    this.setData({
      messages: [...this.data.messages, userMsg],
      input: '',
      sending: true,
      scrollIntoId: `msg-${userMsg.id}`,
    });
    await this.doSend(text, clientTurnId, userMsg.id);
  },

  onRetry(e: WechatMiniprogram.TouchEvent) {
    if (this.data.sending) return;
    const id = e.currentTarget.dataset.id as number;
    const msg = this.data.messages.find((m) => m.id === id);
    if (!msg || msg.role !== 'user' || !msg.clientTurnId) return;
    // 重试复用上一轮的 client_turn_id：服务端幂等，命中则返回同 turn，不重开生成。
    void this.doSend(msg.content, msg.clientTurnId, msg.id);
  },

  // 发一条消息（新发送 or 重试）。成功后追加 assistant 回复并清除失败态；
  // 失败给该 user 消息打 failed 标记，展示重试按钮。
  async doSend(text: string, clientTurnId: string, userMsgId: number) {
    this.setData({ sending: true });
    try {
      const res = await sendCoachChatMessage(text, 'mini-default', clientTurnId);
      const content = res.status === 'completed' ? res.message : undefined;
      if (!content || !content.trim()) {
        throw new Error('no_answer');
      }
      const assistantMsg: CoachMessage = {
        id: ++seq,
        role: 'assistant',
        content,
        html: markdownToHtml(content),
      };
      const messages = this.data.messages.map((m) =>
        m.id === userMsgId ? { ...m, failed: false } : m,
      );
      this.setData({
        messages: [...messages, assistantMsg],
        sending: false,
        scrollIntoId: `msg-${assistantMsg.id}`,
      });
    } catch {
      const messages = this.data.messages.map((m) =>
        m.id === userMsgId ? { ...m, failed: true } : m,
      );
      this.setData({
        messages,
        sending: false,
        scrollIntoId: `msg-${userMsgId}`,
      });
    }
  },

  onMenuTap() {
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },
});
