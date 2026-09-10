import { sendCoachChatStream, fetchCoachHistory, fetchCoachSessions, takePendingCoachContext } from '../../services/coach';
import type { CoachHistoryMessage, CoachSessionTarget, PendingCoachContext, CoachStreamEvent, CoachDone, CoachStreamHandle } from '../../services/coach';
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
  /** 该会话锚定的计划 session（首页「和教练聊一聊」移交）；随每轮消息发送。 */
  target?: CoachSessionTarget;
  /** 展示标签，如「轻松跑 12km · 9月8日」。 */
  contextLabel?: string;
}

// 本地存储 key
const SESSIONS_KEY = 'coach.sessions';
const CURRENT_SESSION_KEY = 'coach.currentSessionId';
// 默认会话：与服务端/历史版本保持一致，保证老用户首次进入不丢历史。
const DEFAULT_SESSION_ID = 'mini-default';
const PLACEHOLDER_TITLE = '新对话';

// 服务端 status 事件的 phase → 提示文案。用户可见的就两个阶段：数据查询（工具 /
// 子 agent 在取数）→ 取数结束、模型开始出正文时切「正在分析」。
const PHASE_LABEL: Record<string, string> = {
  in_subagent: '正在查询数据…',
  running_tool: '正在查询数据…',
  analyzing: '正在分析…',
};

// 当前流式的运行期状态（单会话单流；放 module 级避免给 Page 实例加自定义属性带来的 TS 收窄问题）。
let streamAbort: CoachStreamHandle | null = null;
let streamBuffer = '';
let streamFlushTimer: number | null = null;
// 流式气泡 id 自增：scroll-into-view 只在值变化时滚动，打字机文本不断变长，需跟着滚。
let streamScrollTick = 0;

/** needs_input 时后端 interrupt 里的可展示文本（AskUserQuestionPayload 的 question 优先）。 */
function interruptText(interrupt: unknown): string | undefined {
  if (typeof interrupt === 'string') return interrupt;
  if (interrupt && typeof interrupt === 'object') {
    const o = interrupt as Record<string, unknown>;
    if (typeof o.question === 'string' && o.question) return o.question;
    if (typeof o.header === 'string' && o.header) return o.header;
  }
  return undefined;
}

interface CoachPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  messages: CoachMessage[];
  input: string;
  sending: boolean;
  scrollIntoId: string;
  // 流式回复：streaming 时展示流式气泡；streamPhase 为阶段文案（无正文时显示）；
  // streamText 为累积纯文本（打字机）。done 后转入 messages 的完整 markdown 消息。
  streaming: boolean;
  streamPhase: string;
  streamText: string;
  // 流式气泡 id（随打字机变长自增，drive scroll-into-view 跟随）。
  streamScrollId: string;
  // 键盘高度（px）>0 时把输入栏垫到键盘上方，避免页面被 adjust-position 顶出屏幕。
  keyboardPaddedStyle: string;
  keyboardHeight: number;
  // 会话抽屉
  drawerOpen: boolean;
  sessions: CoachSession[];
  currentSessionId: string;
  // 顶部上下文提示条：存在时表示当前会话锚定了一项计划训练。
  contextHint: string;
  // mp-html 样式：容器兜底颜色/字重 + 结构化 tag 样式（深色主题）。
  containerStyle: string;
  tagStyle: Record<string, string>;
}

interface CoachPageHandlers {
  onInput(e: WechatMiniprogram.Input): void;
  onKeyboardHeightChange(e: WechatMiniprogram.InputKeyboardHeightChange): void;
  onBlur(): void;
  onSend(): Promise<void>;
  onRetry(e: WechatMiniprogram.TouchEvent): void;
  onMenuTap(): void;
  onCloseDrawer(): void;
  onSearchTap(): void;
  onClearContext(): void;
  onNewConversation(): void;
  onSelectSession(e: WechatMiniprogram.TouchEvent): void;
  noop(): void;
  // 内部方法（以 this. 调用，需在接口中声明以便类型收窄）。
  loadSessions(): Promise<void>;
  loadSession(sessionId: string): Promise<void>;
  doSend(text: string, clientTurnId: string, userMsgId: number): Promise<void>;
  startContextSession(pending: PendingCoachContext): void;
  currentSessionTarget(): CoachSessionTarget | undefined;
  contextHintOf(session: CoachSession | undefined): string;
  // 流式回调（事件驱动，页面内以 this. 调用）。
  handleStreamEvent(ev: CoachStreamEvent): void;
  finishStream(done: CoachDone, userMsgId: number): void;
  failStream(error: { code: string; message: string }, userMsgId: number): void;
  resetStream(): void;
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
    streaming: false,
    streamPhase: '',
    streamText: '',
    streamScrollId: 'msg-streaming',
    scrollIntoId: '',
    keyboardHeight: 0,
    keyboardPaddedStyle: '',
    drawerOpen: false,
    sessions: [],
    currentSessionId: DEFAULT_SESSION_ID,
    contextHint: '',
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
    const current = sessions.find((s) => s.id === currentSessionId);
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
      sessions,
      currentSessionId,
      contextHint: this.contextHintOf(current),
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
    // 首页「和教练聊一聊」移交的上下文：新建会话并锚定 target。
    const pending = takePendingCoachContext();
    if (pending) {
      this.startContextSession(pending);
    }
  },

  onUnload() {
    // 离开页面时中止在途流式请求，避免后台继续占用连接/接收 chunk。
    this.resetStream();
  },

  /** 首页「和教练聊一聊」：新建会话并挂 target，展示上下文提示条。 */
  startContextSession(pending: PendingCoachContext) {
    this.resetStream();
    const newSession: CoachSession = {
      id: nextSessionId(),
      title: PLACEHOLDER_TITLE,
      target: pending.target,
      contextLabel: pending.label,
    };
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
      contextHint: this.contextHintOf(newSession),
    });
  },

  /** 当前会话锚定的计划 session；无则 undefined（普通对话）。 */
  currentSessionTarget(): CoachSessionTarget | undefined {
    const s = this.data.sessions.find((x) => x.id === this.data.currentSessionId);
    return s?.target;
  },

  /** 上下文提示条文案；无标签返回空（不显示）。 */
  contextHintOf(session: CoachSession | undefined): string {
    if (!session?.contextLabel) return '';
    return `正在围绕「${session.contextLabel}」对话`;
  },

  /** 清空当前会话的 target：不再围绕该训练对话，后续消息不带 target。 */
  onClearContext() {
    const id = this.data.currentSessionId;
    const sessions = this.data.sessions.map((s) =>
      s.id === id ? { ...s, target: undefined, contextLabel: undefined } : s,
    );
    writeSessions(sessions);
    this.setData({ sessions, contextHint: '' });
  },

  /**
   * 加载指定会话的历史。会话不存在（新会话）时保留欢迎语；
   * 加载失败（后端未配置/网络异常）时也保留欢迎语，便于继续提问。
   */
  async loadSession(sessionId: string) {
    this.resetStream();
    try {
      const history = await fetchCoachHistory(sessionId);
      // 等待网络期间用户可能已切换会话（或首页移交新建了会话），丢弃过期结果。
      if (this.data.currentSessionId !== sessionId) return;
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

  onKeyboardHeightChange(e: WechatMiniprogram.InputKeyboardHeightChange) {
    const h = e.detail?.height || 0;
    if (h === this.data.keyboardHeight) return;
    this.setData({
      keyboardHeight: h,
      // 键盘打开时用实心 padding 顶起输入栏（覆盖底部 tabBar 预留的 calc(120rpx+…)，因为 tabBar 已让位给键盘）；
      // 关闭时清空，回落到底部 tabBar 的常规预留。
      keyboardPaddedStyle: h > 0 ? `padding-bottom:${h}px;` : '',
    });
  },

  // 键盘收起时，微信走 blur 而非 keyboardheightchange=0，这里兜底清掉顶起的 padding，
  // 否则输入栏会停在半空回不到页面底部。
  onBlur() {
    this.setData({ keyboardHeight: 0, keyboardPaddedStyle: '' });
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

  // 发一条消息（新发送 or 重试）。改为流式：立即展示流式气泡（阶段指示 + 打字机），
  // 收到的分段先以纯文本累积，done 后才把完整 markdown 渲染成富文本（mp-html）。
  // DB 幂等仍由 clientTurnId 承担：失败重试复用同一 id，服务端返回同 turn。
  async doSend(text: string, clientTurnId: string, userMsgId: number) {
    this.resetStream();
    this.setData({
      sending: true,
      streaming: true,
      // 空文案：真实阶段由服务端 status 事件驱动（无工具调用的轮次没有查询阶段，
      // 直接跳到「正在分析」）。
      streamPhase: '',
      streamText: '',
      streamScrollId: 'msg-streaming',
      scrollIntoId: 'msg-streaming',
    });
    streamAbort = sendCoachChatStream(
      text,
      this.data.currentSessionId,
      clientTurnId,
      this.currentSessionTarget(),
      {
        onEvent: (ev) => this.handleStreamEvent(ev),
        onComplete: (done) => this.finishStream(done, userMsgId),
        onError: (error) => this.failStream(error, userMsgId),
      },
    );
  },

  /** 流式事件：status 更新阶段文案；delta 累积纯文本（打字机）。 */
  handleStreamEvent(ev: CoachStreamEvent) {
    if (ev.kind === 'delta') {
      // 轻量节流：同一帧内的多个 delta 合并成一次 setData，避免每 token 都刷一次 WXML。
      streamBuffer += ev.delta;
      if (streamFlushTimer == null) {
        streamFlushTimer = setTimeout(() => {
          streamFlushTimer = null;
          const text = this.data.streamText + streamBuffer;
          streamBuffer = '';
          const sid = `msg-streaming-${++streamScrollTick}`;
          this.setData({ streamText: text, streamScrollId: sid, scrollIntoId: sid });
        }, 16);
      }
    } else {
      const label = PHASE_LABEL[ev.phase] ?? '正在分析…';
      if (this.data.streamPhase !== label) this.setData({ streamPhase: label });
    }
  },

  /** 流结束：把完整 markdown 一次性渲染为富文本，转入消息列表。 */
  finishStream(done: CoachDone, userMsgId: number) {
    streamAbort = null;
    if (streamFlushTimer != null) {
      clearTimeout(streamFlushTimer);
      streamFlushTimer = null;
    }
    streamBuffer = '';
    // completed → 正文 done.message；needs_input → interrupt 是追问 payload
    // （AskUserQuestionPayload 含 question），渲染成 assistant 追问，不算失败。
    const content = done.status === 'completed' ? done.message : interruptText(done.interrupt);
    if (!content || !content.trim()) {
      this.failStream({ code: 'empty', message: 'no_answer' }, userMsgId);
      return;
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
      streaming: false,
      streamPhase: '',
      streamText: '',
      scrollIntoId: `msg-${assistantMsg.id}`,
    });
  },

  /** 流失败：清掉流式气泡，给该 user 消息打 failed 标记以展示重试按钮。 */
  failStream(error: { code: string; message: string }, userMsgId: number) {
    streamAbort = null;
    if (streamFlushTimer != null) {
      clearTimeout(streamFlushTimer);
      streamFlushTimer = null;
    }
    streamBuffer = '';
    const messages = this.data.messages.map((m) =>
      m.id === userMsgId ? { ...m, failed: true } : m,
    );
    this.setData({
      messages,
      sending: false,
      streaming: false,
      streamPhase: '',
      streamText: '',
      scrollIntoId: `msg-${userMsgId}`,
    });
  },

  /** 中止在途流 + 清流式状态（切会话 / 新建 / 卸载时调用）。 */
  resetStream() {
    streamAbort?.abort();
    streamAbort = null;
    if (streamFlushTimer != null) {
      clearTimeout(streamFlushTimer);
      streamFlushTimer = null;
    }
    streamBuffer = '';
    this.setData({ sending: false, streaming: false, streamPhase: '', streamText: '' });
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
    this.resetStream();
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
      contextHint: '',
    });
  },

  onSelectSession(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    if (!id) return;
    writeCurrentSessionId(id);
    const selected = this.data.sessions.find((s) => s.id === id);
    this.setData({ currentSessionId: id, drawerOpen: false, contextHint: this.contextHintOf(selected) });
    void this.loadSession(id);
  },
});
