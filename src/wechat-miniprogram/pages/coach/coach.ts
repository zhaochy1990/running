import { sendCoachChatStream, fetchCoachHistory, fetchCoachSessions, takePendingCoachContext } from '../../services/coach';
import type { CoachHistoryMessage, CoachSessionTarget, PendingCoachContext, CoachStreamEvent, CoachDone, CoachStreamHandle } from '../../services/coach';
import {
  abandonMasterPlanDraft,
  activateMasterPlanDraft,
  getCurrentMasterPlan,
  type CurrentSeasonPlan,
  type MasterPlanCard,
} from '../../services/master-plan';
import { ApiError } from '../../services/request';
import { setPendingStrategyDraft, type RaceStrategy } from '../../services/race-strategy';
import { userStore } from '../../store/index';
import { buildCoachCard, looksLikeJsonText, parseLeakedRaceStrategyEnvelope, type CoachCardView } from '../../utils/coachCards';
import { markdownToHtml } from '../../utils/markdown';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

interface CoachMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  // assistant 消息渲染用（GFM→HTML，经 <mp-html> 渲染）；user 消息保持纯文本。
  html?: string;
  // 结构化产物通知卡片（done.card 经 utils/coachCards 翻译）：存在时替代
  // markdown 正文渲染，content 保留作复制全文的兜底；inlineBody 产物
  // （master-plan 摘要即卡片）例外——html 同帧渲染在卡片下方。
  card?: CoachCardView;
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
// 已冲刷进气泡的原始正文累积（streamText 是呈现层文本：JSON 泄漏时被替换成
// 占位文案，不能反向参与累积）。
let streamRawText = '';
let streamFlushTimer: number | null = null;
// 流式气泡 id 自增：scroll-into-view 只在值变化时滚动，打字机文本不断变长，需跟着滚。
let streamScrollTick = 0;
// master-plan 启用/放弃进行中的 plan_id（串行化动作，防双击重复提交）。
let planActionInFlight = '';

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
  // streamNarration 为模型工具调用前的进度说明；streamText 为累积纯文本（打字机）。
  // done 后转入 messages 的完整 markdown 消息，三者都清空。
  streaming: boolean;
  streamPhase: string;
  streamNarration: string;
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
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onInput(e: WechatMiniprogram.Input): void;
  onKeyboardHeightChange(e: WechatMiniprogram.InputKeyboardHeightChange): void;
  onBlur(): void;
  onSend(): Promise<void>;
  onRetry(e: WechatMiniprogram.TouchEvent): void;
  onMessageLongPress(e: WechatMiniprogram.TouchEvent): void;
  copyMessageText(messageId: number): void;
  /** 结构化产物卡片 tap（卡片主体）：产物经 storage 交接后跳目标页（如报告页草稿模式）。 */
  onCardOpen(e: WechatMiniprogram.TouchEvent): void;
  /** 卡片主 CTA：导航类产物（策略）走 onCardOpen 同款跳转；动作类产物
   *  （master-plan 启用）直调端点。 */
  onCardCta(e: WechatMiniprogram.TouchEvent): void;
  /** 卡片次级动作（master-plan 放弃）。 */
  onCardSecondary(e: WechatMiniprogram.TouchEvent): void;
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
  sendText(text: string): Promise<void>;
  doSend(text: string, clientTurnId: string, userMsgId: number): Promise<void>;
  startContextSession(pending: PendingCoachContext): void;
  currentSessionTarget(): CoachSessionTarget | undefined;
  contextHintOf(session: CoachSession | undefined): string;
  // master-plan 卡片动作（#429）：启用（含替换确认）/放弃 + 卡片状态回写。
  activateMasterPlanCard(messageId: number): Promise<void>;
  abandonMasterPlanCard(messageId: number): Promise<void>;
  markMasterPlanCard(messageId: number, badge: string): void;
  markMasterPlanActive(messageId: number): void;
  settlePlanCardFromRecheck(messageId: number, userId: string, planId: string, fallbackToast: string): Promise<void>;
  fetchCurrentPlanSafely(userId: string): Promise<CurrentSeasonPlan | null | 'unknown'>;
  confirmReplacePlan(uncertain: boolean): Promise<boolean>;
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

/** 卡片消息的气泡内容：inlineBody 产物（master-plan 摘要即卡片）正文摘要
 *  保留在卡片下方渲染；其余产物（race-strategy）卡片替代正文，content 留作
 *  复制兜底。 */
function cardCoachMessage(card: CoachCardView, content: string): CoachMessage {
  if (!card.inlineBody) {
    return { id: ++seq, role: 'assistant', content: card.title, card };
  }
  return { id: ++seq, role: 'assistant', content, card, html: markdownToHtml(content) };
}

function toCoachMessage(m: CoachHistoryMessage, target?: CoachSessionTarget): CoachMessage {
  if (m.role === 'assistant') {
    // 首选：服务端信封（挂在产生它的消息上随 checkpoint 持久化，与 done.card
    // 同形），重开会话按行恢复通知卡片，多策略会话每张卡片各自保真。
    const fromServer = buildCoachCard(m.card, target);
    if (fromServer) {
      return cardCoachMessage(fromServer, m.content);
    }
    // 兜底（历史自愈）：防御解析上线前，弱模型曾把策略信封 JSON 当正文写进
    // 会话历史；形似信封的 assistant 文本捞回成通知卡片（无 race target 定位
    // 不了赛事时保持原文）。仅覆盖卡片信封上线前的旧历史。
    const leaked = parseLeakedRaceStrategyEnvelope(m.content);
    if (leaked) {
      const card = buildCoachCard(leaked, target);
      if (card) {
        return cardCoachMessage(card, m.content);
      }
    }
  }
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
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    messages: welcomeMessages(),
    input: '',
    sending: false,
    streaming: false,
    streamPhase: '',
    streamNarration: '',
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
      // markdownToHtml 会产出 GFM 表格；无样式时无边框无对齐，不可读。
      table: 'width:100%;margin:0 0 10px;border-collapse:collapse;color:#e3e2e5;',
      th: 'padding:6px 8px;border:1px solid rgba(255,255,255,0.14);color:#b8b8bc;font-weight:600;text-align:left;',
      td: 'padding:6px 8px;border:1px solid rgba(255,255,255,0.14);color:#e3e2e5;',
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
      const locals = readSessions();
      const localOf = (id: string): CoachSession | undefined => locals.find((l) => l.id === id);
      // 服务端行只有 id/标题：会话 target（race 卡片定位、草稿交接依赖）存在
      // 本地，覆盖时须带回来，否则刷新/重启后卡片 tap 静默退化。
      const list: CoachSession[] = (res.sessions ?? [])
        .map((s) => {
          const local = localOf(s.session_id);
          return {
            id: s.session_id,
            title: s.preview?.trim() ? s.preview : PLACEHOLDER_TITLE,
            ...(local?.target ? { target: local.target } : {}),
            ...(local?.contextLabel ? { contextLabel: local.contextLabel } : {}),
          };
        })
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

  /** 入口「和教练聊一聊」：新建会话并挂 target，展示上下文提示条；带 kickoff 时自动发出首条消息。 */
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
      // kickoff 入口：消息区从入口对话开始，不放通用欢迎语
      messages: pending.kickoff ? [] : welcomeMessages(),
      scrollIntoId: '',
      drawerOpen: false,
      contextHint: this.contextHintOf(newSession),
    });
    // #513：按钮已把意图说清，直接替用户发出首条消息让教练主动开场；
    // 失败时该消息带重试按钮，与手动发送一致。
    if (pending.kickoff) {
      void this.sendText(pending.kickoff);
    }
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
        // 带上会话 target：历史自愈出的策略卡片需要 race_event_id 定位报告页。
        const target = this.data.sessions.find((s) => s.id === sessionId)?.target;
        msgs = history.messages.map((m) => toCoachMessage(m, target));
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

  /**
   * 长按助手消息 → 复制全文。
   *
   * 为什么需要它：mp-html 把每个块渲染成独立的 `<rich-text>`，而 rich-text 的选区
   * 不跨实例——长按一个段落只能选中该段，无法整段答案一次取走。所以这里补一个
   * 「复制全文」入口。用户消息是单个 `<text user-select>`，自身可选中复制，无需接管。
   */
  onMessageLongPress(e: WechatMiniprogram.TouchEvent) {
    const { id, role } = e.currentTarget.dataset as { id?: number; role?: string };
    if (role !== 'assistant' || typeof id !== 'number') return;
    wx.showActionSheet({
      itemList: ['复制全文'],
      success: (res) => {
        if (res.tapIndex === 0) this.copyMessageText(id);
      },
      // 用户点空白取消：静默返回，不要弹错误提示。
      fail: () => undefined,
    });
  },

  /** 复制一条助手消息。优先取渲染后的纯文本，取不到时退回原始 markdown。 */
  copyMessageText(messageId: number) {
    const message = this.data.messages.find((m) => m.id === messageId);
    if (!message) return;
    const component = this.selectComponent(`#md-${messageId}`) as { getText?: () => string } | null;
    const rendered = component?.getText?.();
    // setClipboardData 自带“内容已复制”toast，不再自己弹。
    wx.setClipboardData({ data: rendered && rendered.trim() ? rendered : message.content });
  },

  /** 卡片主体 tap：按产物类型交接后跳目标页。策略草稿经 pending storage 交给报告页；
   *  动作型卡片（master-plan 摘要即卡片）主体不可跳转，动作只走 CTA 按钮。 */
  onCardOpen(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as number;
    const message = this.data.messages.find((m) => m.id === id);
    if (!message?.card) return;
    const card = message.card;
    if (!card.url) return;
    if (card.type === 'race-strategy' && card.data && typeof card.data === 'object') {
      const target = this.currentSessionTarget();
      if (target?.kind === 'race' && target.race_event_id) {
        setPendingStrategyDraft({ raceId: target.race_event_id, strategy: card.data as RaceStrategy });
      }
    }
    wx.navigateTo({ url: card.url });
  },

  /** 主 CTA：master-plan 走启用流；其余产物与主体 tap 同款跳转。 */
  onCardCta(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as number;
    const message = this.data.messages.find((m) => m.id === id);
    if (!message?.card) return;
    if (message.card.type === 'master-plan') {
      void this.activateMasterPlanCard(id);
      return;
    }
    this.onCardOpen(e);
  },

  /** 次级动作：目前只有 master-plan 的「放弃」。 */
  onCardSecondary(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as number;
    const message = this.data.messages.find((m) => m.id === id);
    if (!message?.card || message.card.type !== 'master-plan') return;
    wx.showModal({
      title: '放弃这版计划',
      content: '放弃后该草稿将归档，不可再启用。确定放弃吗？',
      confirmText: '放弃',
      confirmColor: '#ff6363',
      success: (res) => {
        if (res.confirm) void this.abandonMasterPlanCard(id);
      },
      fail: () => undefined,
    });
  },

  /**
   * 启用 master-plan 草稿（#429）：先查当前启用计划——同版已在启用中则直接
   * 回写卡片；有其他启用计划、或状态查不到（可能有）时弹替换确认（底座单人
   * 单 active：启用即归档旧计划，确认是破坏性操作的前置）；确认没有才直接
   * 启用。409（草稿已非 draft）/404 由复查收口，区分「已启用/已失效」。
   */
  async activateMasterPlanCard(messageId: number) {
    const message = this.data.messages.find((m) => m.id === messageId);
    const plan = message?.card?.data as MasterPlanCard | undefined;
    const planId = plan?.plan_id;
    if (!planId || planActionInFlight) return;
    const userId = userStore.getState().user?.id;
    if (!userId) {
      wx.showToast({ title: '请先登录后再启用', icon: 'none' });
      return;
    }
    planActionInFlight = planId;
    try {
      const current = await this.fetchCurrentPlanSafely(userId);
      if (current !== 'unknown' && current !== null && current.plan_id === planId) {
        this.markMasterPlanActive(messageId);
        return;
      }
      if (current !== null) {
        const confirmed = await this.confirmReplacePlan(current === 'unknown');
        if (!confirmed) return;
      }
      try {
        await activateMasterPlanDraft(userId, planId);
        this.markMasterPlanCard(messageId, '已启用');
        wx.showToast({ title: '已启用，可在「我的训练计划」查看', icon: 'none' });
      } catch (err) {
        if (err instanceof ApiError && (err.statusCode === 409 || err.statusCode === 404)) {
          // 409=已非草稿（如已在别处启用）；404=行不存在。复查当前计划收口终态。
          await this.settlePlanCardFromRecheck(messageId, userId, planId, '该计划草稿不存在或已失效');
          return;
        }
        wx.showToast({ title: '启用失败，请稍后再试', icon: 'none' });
      }
    } finally {
      planActionInFlight = '';
    }
  },

  /** 放弃 master-plan 草稿：归档后回写卡片；404（不存在或已非草稿）复查收口，
   *  避免把已在别处启用的计划误标成已失效。 */
  async abandonMasterPlanCard(messageId: number) {
    const message = this.data.messages.find((m) => m.id === messageId);
    const plan = message?.card?.data as MasterPlanCard | undefined;
    const planId = plan?.plan_id;
    if (!planId || planActionInFlight) return;
    const userId = userStore.getState().user?.id;
    if (!userId) {
      wx.showToast({ title: '请先登录后再操作', icon: 'none' });
      return;
    }
    planActionInFlight = planId;
    try {
      try {
        await abandonMasterPlanDraft(userId, planId);
        this.markMasterPlanCard(messageId, '已放弃');
        wx.showToast({ title: '已放弃该草稿', icon: 'none' });
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 404) {
          await this.settlePlanCardFromRecheck(messageId, userId, planId, '该计划草稿不存在');
          return;
        }
        wx.showToast({ title: '操作失败，请稍后再试', icon: 'none' });
      }
    } finally {
      planActionInFlight = '';
    }
  },

  /** 启用/放弃终态回写：改角标并收掉双 CTA（消息数据是静态快照，不回改服务端历史）。 */
  markMasterPlanCard(messageId: number, badge: string) {
    const index = this.data.messages.findIndex((m) => m.id === messageId);
    if (index < 0) return;
    this.setData({
      [`messages[${index}].card.badge`]: badge,
      [`messages[${index}].card.buttonText`]: '',
      [`messages[${index}].card.secondaryButtonText`]: '',
    });
  },

  /** 「这版已是当前启用计划」的幂等回写（预检命中与 409/404 复查命中共用）。 */
  markMasterPlanActive(messageId: number) {
    this.markMasterPlanCard(messageId, '已启用');
    wx.showToast({ title: '这版计划已在启用中', icon: 'none' });
  },

  /**
   * 409/404 后复查一次收口终态：复查命中该 plan → 已启用（幂等）；确认不是
   * → 已失效 + fallbackToast；复查也失败 → 不写终态角标（避免误判），提示
   * 稍后再试，CTA 保留可重试。
   */
  async settlePlanCardFromRecheck(messageId: number, userId: string, planId: string, fallbackToast: string) {
    const recheck = await this.fetchCurrentPlanSafely(userId);
    if (recheck === 'unknown') {
      wx.showToast({ title: '该计划状态暂时查不到，请稍后再试', icon: 'none' });
      return;
    }
    if (recheck !== null && recheck.plan_id === planId) {
      this.markMasterPlanActive(messageId);
      return;
    }
    this.markMasterPlanCard(messageId, '已失效');
    wx.showToast({ title: fallbackToast, icon: 'none' });
  },

  /**
   * 当前启用计划查询三态：计划 | 确认没有（null，服务层已把 404 归一）| 查不
   * 到（网络/5xx）。「查不到」绝不当作「没有」——替换确认等破坏性决策按
   * 「可能有」保守处理。
   */
  async fetchCurrentPlanSafely(userId: string): Promise<CurrentSeasonPlan | null | 'unknown'> {
    try {
      return await getCurrentMasterPlan(userId);
    } catch {
      return 'unknown';
    }
  },

  /** 替换确认弹窗（Promise 化 wx.showModal）；uncertain=当前状态查不到时的保守文案。 */
  confirmReplacePlan(uncertain: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      wx.showModal({
        title: '替换当前计划',
        content: uncertain
          ? '暂时查不到你的计划状态。若已有一版启用中的训练计划，启用这版会替换它（旧计划归档）。确定启用吗？'
          : '你已有一版启用中的训练计划，启用这版会替换它（旧计划归档）。确定启用吗？',
        confirmText: '替换并启用',
        success: (res) => resolve(res.confirm),
        fail: () => resolve(false),
      });
    });
  },

  async onSend() {
    const text = this.data.input.trim();
    if (!text || this.data.sending) return;
    await this.sendText(text);
  },

  /** 发送一条用户消息（输入框发送与入口 kickoff 共用）：刷会话标题、落用户气泡、发起本轮。 */
  async sendText(text: string) {
    if (this.data.sending) return;
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
      streamNarration: '',
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

  /** 流式事件：status 更新阶段文案；narration 更新进度说明；delta 累积纯文本（打字机）。 */
  handleStreamEvent(ev: CoachStreamEvent) {
    if (ev.kind === 'narration') {
      // 模型调用工具前的一句话说明。整段一次到达（不是逐 token），展示最新一条即可；
      // 它属于进度区，绝不进 streamText，否则会被当成回答正文。
      const text = ev.delta.trim();
      if (text.length > 0 && this.data.streamNarration !== text) this.setData({ streamNarration: text });
      return;
    }
    if (ev.kind === 'delta') {
      // 轻量节流：同一帧内的多个 delta 合并成一次 setData，避免每 token 都刷一次 WXML。
      streamBuffer += ev.delta;
      if (streamFlushTimer == null) {
        streamFlushTimer = setTimeout(() => {
          streamFlushTimer = null;
          streamRawText += streamBuffer;
          streamBuffer = '';
          // 旧后端可能把信封 JSON 当正文流出（防御解析上线前）：呈现层换成
          // 中性占位文案（不预设产物类型），done 后由卡片/历史自愈接管。
          const display = looksLikeJsonText(streamRawText) ? '正在整理内容…' : streamRawText;
          const sid = `msg-streaming-${++streamScrollTick}`;
          this.setData({ streamText: display, streamScrollId: sid, scrollIntoId: sid });
        }, 16);
      }
    } else {
      const label = PHASE_LABEL[ev.phase] ?? '正在分析…';
      if (this.data.streamPhase !== label) this.setData({ streamPhase: label });
    }
  },

  /** 流结束：结构化产物出通知卡片，其余把完整 markdown 一次性渲染为富文本。 */
  finishStream(done: CoachDone, userMsgId: number) {
    streamAbort = null;
    if (streamFlushTimer != null) {
      clearTimeout(streamFlushTimer);
      streamFlushTimer = null;
    }
    streamBuffer = '';
    streamRawText = '';
    // completed → 正文 done.message；needs_input → interrupt 是追问 payload
    // （AskUserQuestionPayload 含 question），渲染成 assistant 追问，不算失败。
    let content = done.status === 'completed' ? done.message : interruptText(done.interrupt);
    // 本轮 intent 命中的结构化产物：翻译成通知卡片替代 markdown 气泡（保存由
    // 用户在报告页「应用」触发，不再生成即落库弹窗）。信封不认识时降级 markdown。
    const card = buildCoachCard(done.card, this.currentSessionTarget());
    if ((!content || !content.trim()) && !card) {
      this.failStream({ code: 'empty', message: 'no_answer' }, userMsgId);
      return;
    }
    if (!content || !content.trim()) content = card?.title ?? '';
    const assistantMsg: CoachMessage = {
      id: ++seq,
      role: 'assistant',
      content,
      // 卡片存在时不渲染 markdown 正文（报告页才是完整视图）；inlineBody 产物
      // （master-plan 摘要即卡片）例外——摘要正文跟卡片同泡渲染。
      ...(card && !card.inlineBody
        ? { card }
        : card
          ? { card, html: markdownToHtml(content) }
          : { html: markdownToHtml(content) }),
    };
    const messages = this.data.messages.map((m) =>
      m.id === userMsgId ? { ...m, failed: false } : m,
    );
    this.setData({
      messages: [...messages, assistantMsg],
      sending: false,
      streaming: false,
      streamPhase: '',
      streamNarration: '',
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
    streamRawText = '';
    const messages = this.data.messages.map((m) =>
      m.id === userMsgId ? { ...m, failed: true } : m,
    );
    this.setData({
      messages,
      sending: false,
      streaming: false,
      streamPhase: '',
      streamNarration: '',
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
    streamRawText = '';
    this.setData({ sending: false, streaming: false, streamPhase: '', streamNarration: '', streamText: '' });
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
