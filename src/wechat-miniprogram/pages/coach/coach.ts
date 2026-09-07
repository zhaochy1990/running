import { sendCoachChatMessage, fetchCoachHistory, fetchCoachSessions } from '../../services/coach';
import type { CoachHistoryMessage } from '../../services/coach';
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

/** 本地维护的会话元信息。id 与服务端 thread `{user}:coach:{id}` 一一对应。 */
interface CoachSession {
  id: string;
  title: string;
}

// 本地存储 key
const SESSIONS_KEY = 'coach.sessions';
const CURRENT_SESSION_KEY = 'coach.currentSessionId';
// 默认会话：与服务端/历史版本保持一致，保证老用户首次进入不丢历史。
const DEFAULT_SESSION_ID = 'mini-default';
const PLACEHOLDER_TITLE = '新对话';

interface CoachPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  messages: CoachMessage[];
  input: string;
  sending: boolean;
  scrollIntoId: string;
  // 会话抽屉
  drawerOpen: boolean;
  sessions: CoachSession[];
  currentSessionId: string;
  // mp-html 样式：容器兜底颜色/字重 + 结构化 tag 样式（深色主题）。
  containerStyle: string;
  tagStyle: Record<string, string>;
}

interface CoachPageHandlers {
  onInput(e: WechatMiniprogram.Input): void;
  onSend(): Promise<void>;
  onRetry(e: WechatMiniprogram.TouchEvent): void;
  onMenuTap(): void;
  onCloseDrawer(): void;
  onSearchTap(): void;
  onNewConversation(): void;
  onSelectSession(e: WechatMiniprogram.TouchEvent): void;
  noop(): void;
}

let seq = 0;
let turnSeq = 0;
function nextClientTurnId(): string {
  return `mini-${Date.now()}-${++turnSeq}`;
}
function nextSessionId(): string {
  return `mini-${Date.now()}-${++turnSeq}`;
}
/** 状态栏高度（px）。顶部栏总高沿用固定 128rpx（与 index 页一致）。 */
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
  const statusRpx = Math.round((statusPx * 750) / width);
  return statusRpx + 128 + 24;
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

/** 从本地读会话列表；空则回退默认会话。 */
function readSessions(): CoachSession[] {
  try {
    const raw = wx.getStorageSync(SESSIONS_KEY);
    if (Array.isArray(raw)) {
      const list = raw.filter((s) => s && typeof s.id === 'string' && typeof s.title === 'string');
      if (list.length > 0) return list as CoachSession[];
    }
  } catch {
    /* ignore */
  }
  return [{ id: DEFAULT_SESSION_ID, title: '与教练的对话' }];
}

function writeSessions(list: CoachSession[]): void {
  try {
    wx.setStorageSync(SESSIONS_KEY, list);
  } catch {
    /* ignore */
  }
}

function readCurrentSessionId(): string {
  try {
    const id = wx.getStorageSync(CURRENT_SESSION_KEY);
    if (typeof id === 'string' && id) return id;
  } catch {
    /* ignore */
  }
  return DEFAULT_SESSION_ID;
}

function writeCurrentSessionId(id: string): void {
  try {
    wx.setStorageSync(CURRENT_SESSION_KEY, id);
  } catch {
    /* ignore */
  }
}

/** 截取消息正文作为会话标题。 */
function titleFromText(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > 12 ? `${trimmed.slice(0, 12)}…` : trimmed;
}

Page<CoachPageData, CoachPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    messages: welcomeMessages(),
    input: '',
    sending: false,
    scrollIntoId: '',
    drawerOpen: false,
    sessions: [],
    currentSessionId: DEFAULT_SESSION_ID,
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

  onLoad() {
    const sessions = readSessions();
    const currentSessionId = readCurrentSessionId();
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
      sessions,
      currentSessionId,
    });
    void this.loadSessions();
    void this.loadSession(currentSessionId);
  },

  /**
   * 从后端刷新会话列表（历史抽屉数据）。成功后以服务端为准（跨设备共享）；
   * 失败（后端未部署/网络异常）保留本地列表，保证会话功能可用。
   */
  async loadSessions() {
    try {
      const res = await fetchCoachSessions();
      const list: CoachSession[] = (res.sessions ?? [])
        .map((s) => ({ id: s.session_id, title: s.preview?.trim() ? s.preview : PLACEHOLDER_TITLE }))
        .filter((s, i, arr) => s.id && arr.findIndex((x) => x.id === s.id) === i);
      // 后端尚未落库的新会话（本地刚新建、还没发过消息）不在列表里，
      // 保持它的条目标记在当前会话，避免抽屉里“当前”徽标失效。
      const currentId = readCurrentSessionId();
      if (currentId && !list.some((s) => s.id === currentId)) {
        const local = readSessions().find((s) => s.id === currentId);
        list.unshift(local ?? { id: currentId, title: PLACEHOLDER_TITLE });
      }
      if (list.length > 0) {
        writeSessions(list);
        this.setData({ sessions: list });
      }
    } catch {
      // 后端不可用时保留本地列表（readSessions 已带回退）。
    }
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 2 });
    }
  },

  /**
   * 加载指定会话的历史。会话不存在（新会话）时保留欢迎语；
   * 加载失败（后端未配置/网络异常）时也保留欢迎语，便于继续提问。
   */
  async loadSession(sessionId: string) {
    try {
      const history = await fetchCoachHistory(sessionId);
      let msgs = this.data.messages;
      if (history && Array.isArray(history.messages) && history.messages.length) {
        seq = 0;
        msgs = history.messages.map(toCoachMessage);
      } else {
        seq = 0;
        msgs = welcomeMessages();
      }
      this.setData({
        messages: msgs,
        scrollIntoId: `msg-${msgs[msgs.length - 1].id}`,
      });
    } catch {
      // 历史拉取失败时保留欢迎语。
    }
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ input: e.detail.value });
  },

  async onSend() {
    const text = this.data.input.trim();
    if (!text || this.data.sending) return;

    // 新会话用首条消息当标题（覆盖占位标题）。
    const sessions = this.data.sessions;
    let refreshedSessions = sessions;
    if (this.data.currentSessionId === DEFAULT_SESSION_ID) {
      refreshedSessions = sessions.map((s) =>
        s.id === DEFAULT_SESSION_ID ? { ...s, title: titleFromText(text) } : s,
      );
    } else {
      refreshedSessions = sessions.map((s) =>
        s.id === this.data.currentSessionId && s.title === PLACEHOLDER_TITLE
          ? { ...s, title: titleFromText(text) }
          : s,
      );
    }
    if (refreshedSessions !== sessions) {
      writeSessions(refreshedSessions);
      this.setData({ sessions: refreshedSessions });
    }

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
      const res = await sendCoachChatMessage(text, this.data.currentSessionId, clientTurnId);
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
    this.setData({ drawerOpen: true });
  },

  noop() {
    // 阻止抽屉内容点击冒泡到遮罩关闭（catchtap 占位）。
  },

  onCloseDrawer() {
    this.setData({ drawerOpen: false });
  },

  onSearchTap() {
    wx.showToast({ title: '暂未开放', icon: 'none' });
  },

  onNewConversation() {
    const newSession: CoachSession = { id: nextSessionId(), title: PLACEHOLDER_TITLE };
    const sessions = [newSession, ...this.data.sessions];
    writeSessions(sessions);
    writeCurrentSessionId(newSession.id);
    seq = 0;
    this.setData({
      sessions,
      currentSessionId: newSession.id,
      messages: welcomeMessages(),
      scrollIntoId: '',
      drawerOpen: false,
    });
  },

  onSelectSession(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    if (!id) return;
    writeCurrentSessionId(id);
    this.setData({ currentSessionId: id, drawerOpen: false });
    void this.loadSession(id);
  },
});
