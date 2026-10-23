import { sendCoachChatStream, fetchCoachHistory, fetchCoachSessions, takePendingCoachContext, createCoachShare } from '../../services/coach';
import type { CoachHistoryMessage, CoachSessionTarget, PendingCoachContext, CoachStreamEvent, CoachDone, CoachStreamHandle } from '../../services/coach';
import {
  applyMasterPlanFromContent,
  getCurrentMasterPlan,
  type CurrentSeasonPlan,
  type MasterPlanCard,
  type MasterPlanReplacementExpectation,
} from '../../services/master-plan';
import { ApiError } from '../../services/request';
import {
  deleteCustomWorkout,
  getPlanSessions,
  moveCustomWorkout,
  pushCustomWorkout,
  upsertCustomWorkout,
} from '../../services/plan';
import type { CustomWorkoutCard, PlanSessionRow, WorkoutOpCard } from '../../types/plan';
import { setPendingStrategyDraft, type RaceStrategy } from '../../services/race-strategy';
import { userStore } from '../../store/index';
import { buildCoachCard, looksLikeJsonText, parseLeakedRaceStrategyEnvelope, shanghaiMonthDayLabel, type CoachCardView } from '../../utils/coachCards';
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
  // 该消息在服务端历史投影数组中的序号（分享创建 indices 用，devops#717）。
  // undefined = 不在服务端投影（欢迎语 / 失败 / 生成中），不可多选转发。
  shareIndex?: number;
  // 多选转发：可勾选（投影内已发出消息）与当前勾选态（选择模式渲染用）。
  selectable?: boolean;
  selected?: boolean;
  // 展示时间戳（HH:mm）。服务端历史无逐条时间，只有本会话内新产生的消息带。
  ts?: string;
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
// master-plan 应用进行中的 apply_token（串行化动作，防双击重复提交）。
let planActionInFlight = '';

// ── 多选转发（devops#717）────────────────────────────────────────────────────
// 单次分享条数上限（与服务端 422 口径一致）。
const MAX_SHARE_MESSAGES = 30;
// 分享阅读端页面（P5 落地，路径先按 epic #713 定稿写死）。
const COACH_SHARE_PAGE = '/pages/coach-share/coach-share';
// 当前会话已加载的服务端投影长度：历史加载后 = history.messages.length，
// 之后每条确认落库的新消息（finishStream）递增。本地新气泡按它领投影序号。
let projectionLength = 0;
// 最近一次历史加载是否失败。失败时本地投影序号不可信（欢迎语兜底视图缺服务端
// 前缀），多选入口 toast 拦截，onShow 静默重拉直到同步成功。
let historySyncFailed = false;
// 分享封面本地临时路径（canvas 预生成，5:4）；生成失败保持空，回落默认截图。
let shareCoverPath = '';
let shareCoverTimer: number | null = null;

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

/** 本地消息的展示时间戳（HH:mm）。 */
function nowHhmm(): string {
  const d = new Date();
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 清掉一组消息的勾选态（退出选择模式 / 重新全选前的复位）。 */
function clearSelectionFlags(messages: CoachMessage[]): CoachMessage[] {
  return messages.map((m) => (m.selected ? { ...m, selected: false } : m));
}

/** 封面气泡里的正文节选：去掉 markdown 装饰符并压成单行。 */
function plainExcerpt(text: string): string {
  return text
    .replace(/[#*`>|_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** 分享封面 canvas 2d 上下文的最小结构（wx typings 不带 DOM Canvas 类型）。 */
interface ShareCoverCtx {
  fillStyle: string;
  font: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  beginPath(): void;
  moveTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  closePath(): void;
  fill(): void;
}

/** 封面气泡文本折行：每行 16 个全角字符，最多两行，超长省略号收尾。 */
function coverLines(text: string): string[] {
  const perLine = 16;
  if (text.length <= perLine * 2) {
    return [text.slice(0, perLine), text.slice(perLine)].filter((line) => line.length > 0);
  }
  return [text.slice(0, perLine), `${text.slice(perLine, perLine * 2 - 1)}…`];
}

function roundRectPath(ctx: ShareCoverCtx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 分享封面（5:4，#717）：品牌顶标 STRIDE·砺跑 + 前两条所选对话气泡节选 + 底部落款。
 *  纯绘制闭函数，参照配速卡海报 canvas 先例（strategy.ts drawPoster）。 */
function drawShareCover(
  ctx: ShareCoverCtx,
  width: number,
  height: number,
  picks: Array<{ role: 'user' | 'assistant'; text: string }>,
): void {
  ctx.fillStyle = '#101111';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ff6363';
  ctx.fillRect(0, 0, width, 6);

  ctx.fillStyle = '#ffb3af';
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText('STRIDE · 砺跑', 36, 66);

  let y = 110;
  for (const pick of picks) {
    const lines = coverLines(pick.text);
    ctx.font = '22px sans-serif';
    const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const bubbleWidth = Math.min(Math.ceil(textWidth) + 44, width - 72);
    const bubbleHeight = lines.length * 32 + 28;
    const isUser = pick.role === 'user';
    const x = isUser ? width - 36 - bubbleWidth : 36;
    ctx.fillStyle = isUser ? '#ff6363' : '#2a2b2e';
    roundRectPath(ctx, x, y, bubbleWidth, bubbleHeight, 14);
    ctx.fill();
    ctx.fillStyle = isUser ? '#101111' : '#e3e2e5';
    lines.forEach((line, i) => ctx.fillText(line, x + 22, y + 34 + i * 32));
    y += bubbleHeight + 18;
  }

  ctx.fillStyle = '#8a8a8c';
  ctx.font = '20px sans-serif';
  const logo = '砺跑 · AI 马拉松教练';
  ctx.fillText(logo, (width - ctx.measureText(logo).width) / 2, height - 30);
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
  // 多选转发（devops#717）：selectMode 时顶栏切「已选 N 条」、底栏切
  // [取消][全选][转发 N]，消息行出现勾选框。
  selectMode: boolean;
  selectCount: number;
  allSelected: boolean;
}

interface CoachPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent | WechatMiniprogram.Page.IAsyncCustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onInput(e: WechatMiniprogram.Input): void;
  onKeyboardHeightChange(e: WechatMiniprogram.InputKeyboardHeightChange): void;
  onBlur(): void;
  onSend(): Promise<void>;
  onRetry(e: WechatMiniprogram.TouchEvent): void;
  onMessageLongPress(e: WechatMiniprogram.TouchEvent): void;
  /** 选择模式中点消息：可勾选的切换勾选，不可选的 toast 原因；常态空操作。 */
  onMessageTap(e: WechatMiniprogram.TouchEvent): void;
  /** 消息 footer 的复制按钮（双叠方框线性 icon，#623 决议）。 */
  onCopyFooterTap(e: WechatMiniprogram.TouchEvent): void;
  /** 不可勾选消息的 toast 原因文案（失败 / 非投影消息）。 */
  unselectableReason(message: CoachMessage): string;
  onToggleSelectAll(): void;
  copyMessageText(messageId: number): void;
  /** 结构化产物卡片 tap（卡片主体）：产物经 storage 交接后跳目标页（如报告页草稿模式）。 */
  onCardOpen(e: WechatMiniprogram.TouchEvent): void;
  /** 卡片主 CTA：导航类产物（策略）走 onCardOpen 同款跳转；动作类产物
   *  （master-plan 启用、custom-workout 保存）直调端点。 */
  onCardCta(e: WechatMiniprogram.TouchEvent): void;
  /** 卡片次级 CTA（custom-workout 推送到手表）。 */
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
  applyMasterPlanCard(messageId: number): Promise<void>;
  // custom-workout 卡片动作（devops#587）：保存 / 推送 + 角标回写。
  saveCustomWorkoutCard(messageId: number, opts?: { alreadyGuarded?: boolean; silent?: boolean }): Promise<PlanSessionRow | null>;
  pushCustomWorkoutCard(messageId: number): Promise<void>;
  // workout-op 确认卡动作（devops#698）：删除（modal 双重确认）/ 改期 + 终态回写。
  deleteWorkoutOpCard(messageId: number): Promise<void>;
  moveWorkoutOpCard(messageId: number): Promise<void>;
  markCustomWorkoutCard(messageId: number, badge: string, keepPrimary: boolean, keepSecondary: boolean): void;
  reconcileCustomWorkoutCards(msgs: CoachMessage[]): Promise<void>;
  applyPlanContent(
    messageId: number,
    userId: string,
    applyToken: string,
    content: Record<string, unknown>,
    expectation?: MasterPlanReplacementExpectation,
  ): Promise<void>;
  markMasterPlanCard(messageId: number, badge: string): void;
  fetchCurrentPlanSafely(userId: string): Promise<CurrentSeasonPlan | null | 'unknown'>;
  confirmReplacePlan(uncertain: boolean): Promise<boolean>;
  // 流式回调（事件驱动，页面内以 this. 调用）。
  handleStreamEvent(ev: CoachStreamEvent): void;
  finishStream(done: CoachDone, userMsgId: number): void;
  failStream(error: { code: string; message: string }, userMsgId: number): void;
  resetStream(): void;
  // 多选转发（内部方法，页面内以 this. 调用）。
  enterSelectMode(firstId?: number): void;
  exitSelectMode(): void;
  toggleSelect(id: number): void;
  refreshAllSelected(): void;
  scheduleShareCover(): void;
  drawShareCover(): void;
  createSelectedShare(): Promise<WechatMiniprogram.Page.ICustomShareContent>;
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
  // 欢迎语不在服务端投影里（历史为空时的本地兜底）：shareIndex 缺省 → 不可多选转发。
  return [{ id: ++seq, role: 'assistant', content, html: markdownToHtml(content), selectable: false }];
}

/** 卡片消息的气泡内容：inlineBody 产物（master-plan 摘要即卡片）正文摘要
 *  保留在卡片下方渲染；其余产物（race-strategy）卡片替代正文，content 留作
 *  复制兜底。 */
function cardCoachMessage(card: CoachCardView, content: string, shareIndex?: number): CoachMessage {
  if (!card.inlineBody) {
    return { id: ++seq, role: 'assistant', content: card.title, card, shareIndex, selectable: true };
  }
  return { id: ++seq, role: 'assistant', content, card, shareIndex, selectable: true, html: markdownToHtml(content) };
}

function toCoachMessage(m: CoachHistoryMessage, index: number, target?: CoachSessionTarget): CoachMessage {
  if (m.role === 'assistant') {
    // 首选：服务端信封（挂在产生它的消息上随 checkpoint 持久化，与 done.card
    // 同形），重开会话按行恢复通知卡片，多策略会话每张卡片各自保真。
    const fromServer = buildCoachCard(m.card, target);
    if (fromServer) {
      return cardCoachMessage(fromServer, m.content, index);
    }
    // 兜底（历史自愈）：防御解析上线前，弱模型曾把策略信封 JSON 当正文写进
    // 会话历史；形似信封的 assistant 文本捞回成通知卡片（无 race target 定位
    // 不了赛事时保持原文）。仅覆盖卡片信封上线前的旧历史。
    const leaked = parseLeakedRaceStrategyEnvelope(m.content);
    if (leaked) {
      const card = buildCoachCard(leaked, target);
      if (card) {
        return cardCoachMessage(card, m.content, index);
      }
    }
  }
  const msg: CoachMessage = {
    id: ++seq,
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
    // 消息序号映射（devops#717）：历史行序 = 服务端投影序，分享创建直接引用。
    shareIndex: index,
    selectable: true,
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
  /**
   * 多选中且已有勾选 → 转发所选对话；其余（含胶囊菜单转发、未同步态）走品牌
   * 默认卡。静态字段是兜底（微信对 promise 自带 3 秒预算，超时用它）；promise
   * 里调创建端点换真 sid。封面用预生成图，生成失败回落默认截图。
   */
  onShareAppMessage() {
    if (this.data.selectMode && this.data.selectCount > 0 && !historySyncFailed) {
      return {
        ...defaultShareAppMessage(),
        ...(shareCoverPath ? { imageUrl: shareCoverPath } : {}),
        promise: this.createSelectedShare(),
      };
    }
    return defaultShareAppMessage();
  },
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
    selectMode: false,
    selectCount: 0,
    allSelected: false,
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
    // 本页是冷启动落地页（tabBar 首位）：先等认证 settle 再拉会话/消息，
    // 避免首屏请求在异步登录完成前发出（无 token / 过期 token）被数据面 401。
    userStore.waitForAuth().then(() => {
      const { isAuthenticated } = userStore.getState();
      if (!isAuthenticated) {
        // 会话失效/未绑定：正常情况下 checkAuth 会发起 reLaunch 到登录页，这里兜底。
        wx.reLaunch({ url: '/pages/login/login' });
        return;
      }
      void this.loadSessions();
      void this.loadSession(currentSessionId);
    });
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
      tabBar.setData({ selected: 0 });
    }
    // 首页「和教练聊一聊」移交的上下文：新建会话并锚定 target。
    const pending = takePendingCoachContext();
    if (pending) {
      this.startContextSession(pending);
    }
    // 上次历史加载失败的静默重拉：同步成功前多选转发保持拦截（投影序号不可信）。
    if (historySyncFailed) {
      void this.loadSession(this.data.currentSessionId);
    }
  },

  onUnload() {
    // 离开页面时中止在途流式请求，避免后台继续占用连接/接收 chunk。
    this.resetStream();
    if (shareCoverTimer != null) {
      clearTimeout(shareCoverTimer);
      shareCoverTimer = null;
    }
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
    projectionLength = 0;
    this.setData({
      sessions,
      currentSessionId: newSession.id,
      // kickoff 入口：消息区从入口对话开始，不放通用欢迎语
      messages: pending.kickoff ? [] : welcomeMessages(),
      scrollIntoId: '',
      drawerOpen: false,
      contextHint: this.contextHintOf(newSession),
      selectMode: false,
      selectCount: 0,
      allSelected: false,
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
        msgs = history.messages.map((m, index) => toCoachMessage(m, index, target));
        // 消息序号映射（devops#717）：历史行序即服务端投影序，作为分享 indices 基准。
        projectionLength = history.messages.length;
      } else {
        seq = 0;
        projectionLength = 0;
        msgs = welcomeMessages();
      }
      // 自建课卡片对账：历史是静态快照，卡片按钮态只活在内存里，刷新即回退
      // （10-20 用户实证）。用课表行的 save_token 对上卡片信封，恢复终态。
      try {
        await this.reconcileCustomWorkoutCards(msgs);
      } catch {
        // 对账失败按未保存渲染（旧版 Go api 无 save_token 时同样静默降级）。
      }
      historySyncFailed = false;
      this.setData({
        messages: msgs,
        scrollIntoId: `msg-${msgs[msgs.length - 1].id}`,
      });
    } catch {
      // 历史拉取失败时保留欢迎语。
      historySyncFailed = true;
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
   * 长按消息 → 直接进选择模式且该条预选中（#623 定稿 B 直进式，无菜单）。
   * 「复制全文」入口已迁移到每条 assistant 消息下方的常驻 footer。
   * 选择模式中长按 = 切换勾选（微信范式）；不可选消息 toast 原因。
   */
  onMessageLongPress(e: WechatMiniprogram.TouchEvent) {
    const { id } = e.currentTarget.dataset as { id?: number };
    if (typeof id !== 'number') return;
    if (this.data.selectMode) {
      this.toggleSelect(id);
      return;
    }
    if (historySyncFailed) {
      wx.showToast({ title: '对话尚未同步，暂时无法多选转发', icon: 'none' });
      return;
    }
    const message = this.data.messages.find((m) => m.id === id);
    if (!message) return;
    if (!message.selectable) {
      wx.showToast({ title: this.unselectableReason(message), icon: 'none' });
      return;
    }
    this.enterSelectMode(id);
  },

  /** 选择模式中点消息行：可勾选的切换勾选，不可选的 toast 原因（#717）。 */
  onMessageTap(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.selectMode) return;
    const { id } = e.currentTarget.dataset as { id?: number };
    if (typeof id !== 'number') return;
    this.toggleSelect(id);
  },

  /** 消息 footer 复制按钮：复制全文（复用 mp-html getText 逻辑，与原长按菜单同源）。
   *  卡片消息（含 inlineBody 摘要型）不渲染 icon，点击也不触发——卡片即产物
   *  本体无全文可复制（与 wxml 的隐藏条件同款闸门，10-23 用户反馈全卡片统一）。 */
  onCopyFooterTap(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as number;
    if (typeof id !== 'number') return;
    const message = this.data.messages.find((m) => m.id === id);
    if (message?.card) return;
    this.copyMessageText(id);
  },

  /** 不可勾选的原因文案（点击灰显消息时 toast）。 */
  unselectableReason(message: CoachMessage): string {
    if (message.failed) return '发送失败的消息不可转发';
    return '该消息暂不可转发';
  },

  /** 进入选择模式；长按的那条直接预选中（0→1 触发封面预生成）。上次选中的
   *  旧封面一并作废：新封面生成前转发回落默认截图，避免张冠李戴。 */
  enterSelectMode(firstId?: number) {
    shareCoverPath = '';
    this.setData({ selectMode: true, selectCount: 0, allSelected: false });
    if (firstId !== undefined) this.toggleSelect(firstId);
  },

  /** 退出选择模式：清全部勾选，顶栏/底栏还原。 */
  exitSelectMode() {
    if (!this.data.selectMode) return;
    this.setData({
      selectMode: false,
      selectCount: 0,
      allSelected: false,
      messages: clearSelectionFlags(this.data.messages),
    });
  },

  /** 勾选/取消一条：上限 30 拦截；不可选 toast 原因。 */
  toggleSelect(id: number) {
    const index = this.data.messages.findIndex((m) => m.id === id);
    if (index < 0) return;
    const message = this.data.messages[index];
    if (!message.selectable) {
      wx.showToast({ title: this.unselectableReason(message), icon: 'none' });
      return;
    }
    if (!message.selected) {
      if (this.data.selectCount >= MAX_SHARE_MESSAGES) {
        wx.showToast({ title: `一次最多转发 ${MAX_SHARE_MESSAGES} 条`, icon: 'none' });
        return;
      }
      this.setData({ [`messages[${index}].selected`]: true, selectCount: this.data.selectCount + 1 });
    } else {
      this.setData({ [`messages[${index}].selected`]: false, selectCount: this.data.selectCount - 1 });
    }
    this.refreshAllSelected();
    this.scheduleShareCover();
  },

  /** 全选/取消全选：全选超限自动截前 30（#717）。 */
  onToggleSelectAll() {
    if (!this.data.selectMode) return;
    if (this.data.allSelected) {
      this.setData({ messages: clearSelectionFlags(this.data.messages), selectCount: 0, allSelected: false });
      return;
    }
    // 从清空状态重选前 30 条可选消息，避免与已有勾选并集突破上限。
    const messages = clearSelectionFlags(this.data.messages);
    let count = 0;
    for (let i = 0; i < messages.length && count < MAX_SHARE_MESSAGES; i += 1) {
      const m = messages[i];
      if (m.selectable) {
        messages[i] = { ...m, selected: true };
        count += 1;
      }
    }
    const selectableCount = messages.filter((m) => m.selectable).length;
    this.setData({
      messages,
      selectCount: count,
      allSelected: selectableCount > 0 && count >= selectableCount,
    });
    if (selectableCount > MAX_SHARE_MESSAGES) {
      wx.showToast({ title: `一次最多转发 ${MAX_SHARE_MESSAGES} 条`, icon: 'none' });
    }
    this.scheduleShareCover();
  },

  /** 已选是否等于可选全集（底栏「全选/取消全选」文案切换）。 */
  refreshAllSelected() {
    const selectable = this.data.messages.filter((m) => m.selectable);
    const allSelected = selectable.length > 0 && selectable.every((m) => m.selected);
    if (allSelected !== this.data.allSelected) this.setData({ allSelected });
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

  /** 主 CTA：master-plan 走启用流；custom-workout 走保存流；workout-op 走
   *  删除/改期确认流；其余产物与主体 tap 同款跳转。 */
  onCardCta(e: WechatMiniprogram.TouchEvent): void {
    const id = e.currentTarget.dataset.id as number;
    const message = this.data.messages.find((m) => m.id === id);
    if (!message?.card) return;
    if (message.card.type === 'master-plan') {
      void this.applyMasterPlanCard(id);
      return;
    }
    if (message.card.type === 'custom-workout') {
      void this.saveCustomWorkoutCard(id);
      return;
    }
    if (message.card.type === 'workout-op') {
      const op = message.card.data as WorkoutOpCard;
      if (op.op === 'move') {
        void this.moveWorkoutOpCard(id);
      } else {
        void this.deleteWorkoutOpCard(id);
      }
      return;
    }
    this.onCardOpen(e);
  },

  /** 次级 CTA（devops#587）：自建课卡片「推送到手表」——未保存先保存
   * （save_token 幂等链）再调推送端点。 */
  onCardSecondary(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as number;
    const message = this.data.messages.find((m) => m.id === id);
    if (!message?.card) return;
    if (message.card.type === 'custom-workout') {
      void this.pushCustomWorkoutCard(id);
      return;
    }
  },

  /** 保存自建课卡片：save_token 幂等 upsert，成功回写「已保存」角标并收掉主
   * CTA（推送按钮保留，保存后仍可推送）；失败不写终态可重试。返回 workout
   * 行（推送链复用同一入口，silent 不弹 toast 以免顶掉推送 loading）。 */
  async saveCustomWorkoutCard(messageId: number, opts: { alreadyGuarded?: boolean; silent?: boolean } = {}): Promise<PlanSessionRow | null> {
    const message = this.data.messages.find((m) => m.id === messageId);
    const card = message?.card?.data as CustomWorkoutCard | undefined;
    if (!card?.save_token || !card.spec) {
      this.markCustomWorkoutCard(messageId, '已失效', false, false);
      wx.showToast({ title: '这张卡片不可再保存，请重新生成', icon: 'none' });
      return null;
    }
    if (!userStore.getState().user?.id) {
      wx.showToast({ title: '请先登录后再保存', icon: 'none' });
      return null;
    }
    if (!opts.alreadyGuarded && planActionInFlight) return null;
    planActionInFlight = card.save_token;
    try {
      const row = await upsertCustomWorkout(card);
      this.markCustomWorkoutCard(messageId, '已保存', false, true);
      if (!opts.silent) wx.showToast({ title: '已保存', icon: 'success' });
      return row;
    } catch {
      wx.showToast({ title: '保存失败，请稍后再试', icon: 'none' });
      return null;
    } finally {
      planActionInFlight = '';
    }
  },

  /** 推送自建课到手表：未保存先保存（幂等），再调推送端点；成功角标「已推
   * 送」（隐含已保存），失败不写终态可重试。手表未绑定/不支持沿用服务端
   * 失败文案。 */
  async pushCustomWorkoutCard(messageId: number) {
    if (planActionInFlight) return;
    planActionInFlight = 'push';
    wx.showLoading({ title: '推送中...', mask: true });
    try {
      const row = await this.saveCustomWorkoutCard(messageId, { alreadyGuarded: true, silent: true });
      if (!row?.workout_id) return;
      await pushCustomWorkout(row.workout_id);
      this.markCustomWorkoutCard(messageId, '已推送', false, false);
      wx.showToast({ title: '已推送到手表', icon: 'success' });
    } catch (err: any) {
      const msg = err?.detail || err?.message || '推送失败';
      wx.showToast({ title: msg.length > 15 ? '推送失败' : msg, icon: 'none' });
    } finally {
      wx.hideLoading();
      planActionInFlight = '';
    }
  },

  /**
   * 删除确认卡 CTA（devops#698）：wx.showModal 双重确认（#669 决策：删除破坏
   * 性最强，卡片确认之外再过一道 modal）→ 现有软删端点。404 = 该课已在今天页
   * 等别处删除，同样是删除终态（「该课已删除」），不按失败处理。modal 期间
   * 持有 planActionInFlight，防 modal 未答时重复触发其它卡动作。
   */
  async deleteWorkoutOpCard(messageId: number) {
    const message = this.data.messages.find((m) => m.id === messageId);
    const op = message?.card?.data as WorkoutOpCard | undefined;
    if (!op?.workout_id) return;
    if (planActionInFlight) return;
    const userId = userStore.getState().user?.id;
    if (!userId) {
      wx.showToast({ title: '请先登录后再操作', icon: 'none' });
      return;
    }
    planActionInFlight = op.workout_id;
    try {
      const dayLabel = shanghaiMonthDayLabel(op.date);
      const confirmed = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: '删除训练课',
          content: `确定删除「${op.name}」（${dayLabel}）吗？`,
          confirmText: '删除',
          success: (res) => resolve(res.confirm),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) return;
      await deleteCustomWorkout(userId, op.workout_id);
      this.markCustomWorkoutCard(messageId, '已删除', false, false);
      wx.showToast({ title: '已删除', icon: 'success' });
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        this.markCustomWorkoutCard(messageId, '已删除', false, false);
        wx.showToast({ title: '该课已删除', icon: 'none' });
        return;
      }
      wx.showToast({ title: '删除失败，请稍后再试', icon: 'none' });
    } finally {
      planActionInFlight = '';
    }
  },

  /**
   * 改期确认卡 CTA（devops#698）：直调 T1 move 端点（devops#696）。服务端先
   * 改 DB 日期，已推送课 best-effort 重推：watch_synced=true → 「已改期」；
   * false → 「已改期·手表未同步」（改期已生效，仅手表副本未跟上，toast 说明）。
   * 失败不写终态可重试；watch_synced 只活在本次响应里，刷新后对账只能恢复
   * 「已改期」（已知局限，devops#669）。
   */
  async moveWorkoutOpCard(messageId: number) {
    const message = this.data.messages.find((m) => m.id === messageId);
    const op = message?.card?.data as WorkoutOpCard | undefined;
    if (op?.op !== 'move' || !op.workout_id || !op.new_date) return;
    if (planActionInFlight) return;
    const userId = userStore.getState().user?.id;
    if (!userId) {
      wx.showToast({ title: '请先登录后再操作', icon: 'none' });
      return;
    }
    planActionInFlight = op.workout_id;
    wx.showLoading({ title: '改期中...', mask: true });
    try {
      const res = await moveCustomWorkout(userId, op.workout_id, op.new_date);
      if (res.watch_synced) {
        this.markCustomWorkoutCard(messageId, '已改期', false, false);
        wx.showToast({ title: '已改期', icon: 'success' });
      } else {
        this.markCustomWorkoutCard(messageId, '已改期·手表未同步', false, false);
        wx.showToast({ title: '已改期，手表暂未同步', icon: 'none' });
      }
    } catch {
      wx.showToast({ title: '改期失败，请稍后再试', icon: 'none' });
    } finally {
      wx.hideLoading();
      planActionInFlight = '';
    }
  },

  /**
   * 应用 master-plan 卡片（#585 apply-from-content）：卡片携带完整 v2 content
   * + 一次性 apply_token。先查当前启用计划（#537 三态预检）——有则弹替换确认、
   * 带确认身份应用；确认没有才直接应用；查不到按「可能有」保守确认后应用。
   * 409（身份过期/存在未确认）/422（内容无效）由复查收口，区分「已失效/保留
   * 重试」。旧卡片（#429 只带 plan_id）与降级卡片：draft 已下线，直接已失效
   * 兜底。
   */
  async applyMasterPlanCard(messageId: number) {
    const message = this.data.messages.find((m) => m.id === messageId);
    const plan = message?.card?.data as MasterPlanCard | undefined;
    if (planActionInFlight) return;
    const applyToken = plan?.apply_token;
    const content = plan?.content;
    if (!applyToken || !content) {
      // 旧卡片/降级卡片：无 apply 载荷（draft 端点已随 #585 下线）。
      this.markMasterPlanCard(messageId, '已失效');
      wx.showToast({ title: '这版计划不可再应用，请重新生成', icon: 'none' });
      return;
    }
    const userId = userStore.getState().user?.id;
    if (!userId) {
      wx.showToast({ title: '请先登录后再应用', icon: 'none' });
      return;
    }
    planActionInFlight = applyToken;
    try {
      const current = await this.fetchCurrentPlanSafely(userId);
      if (current !== null && current !== 'unknown') {
        const confirmed = await this.confirmReplacePlan(false);
        if (!confirmed) return;
        await this.applyPlanContent(messageId, userId, applyToken, content, {
          expected_active_plan_id: current.plan_id,
          // v1（markdown）行没有 revision 概念，按 API 契约传哨兵值 1（服务端
          // 只比对 plan_id）；v2 传真实 revision。
          expected_active_revision: current.revision ?? 1,
        });
        return;
      }
      if (current === 'unknown') {
        // 查不到当前状态：按「可能有」保守确认（绝不把查不到当没有）。
        const confirmed = await this.confirmReplacePlan(true);
        if (!confirmed) return;
      }
      await this.applyPlanContent(messageId, userId, applyToken, content);
    } finally {
      planActionInFlight = '';
    }
  },

  /**
   * 调用户端 apply 端点并回写卡片终态。409 = 确认身份已过期或存在未确认的
   * active（并发场景）；422 = 内容无效。复查一次：查不到 → 不写终态角标、
   * CTA 保留可重试；查得到 → 这版已失效（服务端幂等保证同一 token 重放不会
   * 产生第二份计划，因此不存在「已在别处应用」的歧义态）。
   */
  async applyPlanContent(
    messageId: number,
    userId: string,
    applyToken: string,
    content: Record<string, unknown>,
    expectation?: MasterPlanReplacementExpectation,
  ) {
    try {
      await applyMasterPlanFromContent(userId, applyToken, content, expectation);
      this.markMasterPlanCard(messageId, '已应用');
      wx.showToast({ title: '已应用，可在「我的训练计划」查看', icon: 'none' });
    } catch (err) {
      if (err instanceof ApiError && (err.statusCode === 409 || err.statusCode === 422)) {
        const recheck = await this.fetchCurrentPlanSafely(userId);
        if (recheck === 'unknown') {
          wx.showToast({ title: '该计划状态暂时查不到，请稍后再试', icon: 'none' });
          return;
        }
        this.markMasterPlanCard(messageId, '已失效');
        wx.showToast({
          title: err.statusCode === 422 ? '这版计划内容无效，无法应用' : '当前计划已更新，这版已失效',
          icon: 'none',
        });
        return;
      }
      wx.showToast({ title: '应用失败，请稍后再试', icon: 'none' });
    }
  },

  /** 应用/失效终态回写：改角标并收掉 CTA（消息数据是静态快照，不回改服务端历史）。 */
  markMasterPlanCard(messageId: number, badge: string) {
    const index = this.data.messages.findIndex((m) => m.id === messageId);
    if (index < 0) return;
    this.setData({
      [`messages[${index}].card.badge`]: badge,
      [`messages[${index}].card.buttonText`]: '',
      [`messages[${index}].card.secondaryButtonText`]: '',
    });
  },

  /** 自建课卡片状态回写：badge + 双 CTA 独立收放（保存只收主 CTA，推送收双）。 */
  markCustomWorkoutCard(messageId: number, badge: string, keepPrimary: boolean, keepSecondary: boolean) {
    const index = this.data.messages.findIndex((m) => m.id === messageId);
    if (index < 0) return;
    const card = this.data.messages[index]?.card;
    if (!card) return;
    this.setData({
      [`messages[${index}].card.badge`]: badge,
      [`messages[${index}].card.buttonText`]: keepPrimary ? card.buttonText : '',
      [`messages[${index}].card.secondaryButtonText`]: keepSecondary ? card.secondaryButtonText : '',
    });
  },

  /**
   * 自建课卡片对账：历史消息是 checkpoint 静态快照，按钮终态只活在内存，
   * 刷新/重进后卡片会回到「待保存/待确认」原状（10-20 用户实证）。
   * - custom-workout 卡（含 devops#698 reissue 卡——复用原 save_token，同一
   *   匹配天然恢复）：按 save_token 对上课表行，恢复「已保存/已推送」。
   * - workout-op 卡（devops#698）：按 workout_id 对账——行消失 → 「已删除」
   *   终态；行在且日期已等于 move 的 new_date → 「已改期」（watch_synced 只
   *   活在 CTA 响应里，对账恢复不了，已知局限见 devops#669）。
   * 对账窗口取 custom 卡日期与 op 卡 date/new_date 的并集 min~max；任何失败
   * 静默保持原状（旧版 Go api 无 save_token 时同样降级为未保存）。
   */
  async reconcileCustomWorkoutCards(msgs: CoachMessage[]) {
    const uid = userStore.getState().user?.id;
    if (!uid) return;
    const customCards = msgs
      .map((m) => m.card)
      .filter((c): c is CoachCardView & { type: 'custom-workout'; data: CustomWorkoutCard } =>
        Boolean(c && c.type === 'custom-workout' && (c.data as CustomWorkoutCard)?.save_token),
      );
    const opCards = msgs
      .map((m) => m.card)
      .filter((c): c is CoachCardView & { type: 'workout-op'; data: WorkoutOpCard } =>
        Boolean(c && c.type === 'workout-op' && (c.data as WorkoutOpCard)?.workout_id),
      );
    if (customCards.length === 0 && opCards.length === 0) return;
    const dates = [
      ...customCards.map((c) => c.data.date),
      ...opCards.flatMap((c) => [c.data.date, ...(c.data.op === 'move' ? [c.data.new_date] : [])]),
    ].sort();
    const { sessions } = await getPlanSessions(uid, dates[0], dates[dates.length - 1]);
    const byToken = new Map(
      sessions
        .filter((r) => r.source === 'custom' && r.save_token)
        .map((r) => [r.save_token as string, r]),
    );
    for (const card of customCards) {
      const row = byToken.get(card.data.save_token);
      if (!row) continue;
      if (row.pushed === true) {
        card.badge = '已推送';
        card.buttonText = '';
        card.secondaryButtonText = '';
      } else {
        card.badge = '已保存';
        card.buttonText = '';
      }
    }
    // workout-op 卡按 workout_id 对账（workout 行 ID 全局唯一，直接索引）。
    const byWorkoutId = new Map(sessions.map((r) => [r.workout_id, r]));
    for (const card of opCards) {
      const op = card.data;
      const row = byWorkoutId.get(op.workout_id);
      if (!row) {
        // 行消失（软删/归档后不再出现在 active 投影里）：删除终态。move 卡的
        // 行同样可能已被别处删除，一并归「已删除」。
        card.badge = '已删除';
        card.buttonText = '';
        card.secondaryButtonText = '';
        continue;
      }
      if (op.op === 'move' && row.date === op.new_date) {
        card.badge = '已改期';
        card.buttonText = '';
        card.secondaryButtonText = '';
      }
    }
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
          ? '暂时查不到你的计划状态。若已有一版启用中的训练计划，应用这版会替换它（旧计划归档）。确定应用吗？'
          : '你已有一版启用中的训练计划，应用这版会替换它（旧计划归档）。确定应用吗？',
        confirmText: '替换并应用',
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
    // user 气泡先占位（无投影序号，流结束确认落库后由 finishStream 领号）。
    const userMsg: CoachMessage = { id: ++seq, role: 'user', content: text, clientTurnId, ts: nowHhmm() };
    this.setData({
      messages: [...this.data.messages, userMsg],
      input: '',
      sending: true,
      scrollIntoId: `msg-${userMsg.id}`,
    });
    await this.doSend(text, clientTurnId, userMsg.id);
  },

  onRetry(e: WechatMiniprogram.TouchEvent) {
    // 选择模式下重试按钮只提示不可转发，不触发重发（catchtap 已阻止冒泡勾选）。
    if (this.data.selectMode) {
      wx.showToast({ title: '发送失败的消息不可转发', icon: 'none' });
      return;
    }
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
      if (done.status === 'completed') {
        // 空回复降级（服务端实证：reasoning 吃满 output budget）：turn 已完成落库，
        // user 消息照常可分享；空 assistant 回复在服务端投影里也占一位（无气泡
        // 渲染）。两处都计入长度，防止后续轮次序号漂移。
        const messages = this.data.messages.map((m) =>
          m.id === userMsgId ? { ...m, failed: false, shareIndex: projectionLength, selectable: true, ts: nowHhmm() } : m,
        );
        projectionLength += 2;
        this.setData({
          messages,
          sending: false,
          streaming: false,
          streamPhase: '',
          streamNarration: '',
          streamText: '',
          scrollIntoId: `msg-${userMsgId}`,
        });
        this.refreshAllSelected();
        return;
      }
      this.failStream({ code: 'empty', message: 'no_answer' }, userMsgId);
      return;
    }
    if (!content || !content.trim()) content = card?.title ?? '';
    // 本轮确认落库：user 气泡占一个服务端投影位；completed 才有 assistant 回复
    // 占下一个位。needs_input 的追问泡只是本地渲染（服务端 checkpoint 的 AI 消息
    // 带 tool_calls，投影层剔除），不领序号、不可多选。
    const userShareIndex = projectionLength;
    projectionLength += 1;
    const assistantShareIndex = done.status === 'completed' ? projectionLength++ : undefined;
    const ts = nowHhmm();
    const messages = this.data.messages.map((m) =>
      m.id === userMsgId ? { ...m, failed: false, shareIndex: userShareIndex, selectable: true, ts } : m,
    );
    const assistantMsg: CoachMessage = {
      id: ++seq,
      role: 'assistant',
      content,
      ts,
      selectable: true,
      ...(assistantShareIndex !== undefined ? { shareIndex: assistantShareIndex } : {}),
      // 卡片存在时不渲染 markdown 正文（报告页才是完整视图）；inlineBody 产物
      // （master-plan 摘要即卡片）例外——摘要正文跟卡片同泡渲染。
      ...(card && !card.inlineBody
        ? { card }
        : card
          ? { card, html: markdownToHtml(content) }
          : { html: markdownToHtml(content) }),
    };
    this.setData({
      messages: [...messages, assistantMsg],
      sending: false,
      streaming: false,
      streamPhase: '',
      streamNarration: '',
      streamText: '',
      scrollIntoId: `msg-${assistantMsg.id}`,
    });
    // 选择模式下流结束追加了新消息：全集变了，重算「全选」态（无选择模式时为无害空转）。
    this.refreshAllSelected();
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


  /**
   * 分享封面预生成（devops#717）：勾选变化后防抖重画 5:4 封面（品牌顶标 +
   * 前两条所选对话节选 + 底部落款），本地临时路径备用。全链路 fail-soft：
   * canvas 不可用/绘制失败只意味着分享卡回落微信默认截图。
   */
  scheduleShareCover() {
    if (this.data.selectCount === 0) return;
    if (shareCoverTimer != null) clearTimeout(shareCoverTimer);
    shareCoverTimer = setTimeout(() => {
      shareCoverTimer = null;
      this.drawShareCover();
    }, 300);
  },

  drawShareCover() {
    if (this.data.selectCount === 0) return;
    const picks = this.data.messages
      .filter((m) => m.selected)
      .slice(0, 2)
      .map((m) => ({ role: m.role, text: plainExcerpt(m.content) }));
    if (picks.length === 0) return;
    const query = wx.createSelectorQuery().in(this as never);
    query
      .select('#share-cover')
      .fields({ node: true }, (res) => {
        const canvas = (res as { node?: unknown })?.node as
          | { width: number; height: number; getContext(type: '2d'): unknown }
          | undefined;
        if (!canvas) return;
        const width = 500;
        const height = 400;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d') as ShareCoverCtx;
        drawShareCover(ctx, width, height, picks);
        wx.canvasToTempFilePath({
          canvas: canvas as unknown as WechatMiniprogram.Canvas,
          x: 0,
          y: 0,
          width,
          height,
          destWidth: width,
          destHeight: height,
          success: (out) => {
            shareCoverPath = out.tempFilePath;
          },
          fail: () => {
            // fail-soft：无封面时微信用页面默认截图。
          },
        });
      })
      .exec();
  },

  /**
   * 创建分享快照并产出真转发内容：path 带短 sid（阅读端 P5 落地）、标题
   * `{昵称} 与 AI 教练的对话 · N 条`、封面用预生成图。任何失败/超时都回落
   * 默认品牌分享并 toast，绝不阻塞转发面板。
   */
  createSelectedShare(): Promise<WechatMiniprogram.Page.ICustomShareContent> {
    const selected = this.data.messages.filter((m) => m.selected && m.shareIndex !== undefined);
    // 升序去重（服务端会再规范化一次，这里发干净数据）。
    const indices = [...new Set(selected.map((m) => m.shareIndex as number))].sort((a, b) => a - b);
    const name = (userStore.getState().user?.name ?? '').trim().slice(0, 64);
    const title = name
      ? `${name} 与 AI 教练的对话 · ${indices.length} 条`
      : `我与 AI 教练的对话 · ${indices.length} 条`;
    const fallback = defaultShareAppMessage();
    return new Promise((resolve) => {
      let settled = false;
      const finishFallback = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wx.showToast({ title: reason, icon: 'none' });
        resolve(fallback);
      };
      // 抢在微信 3 秒预算之前主动回落，保证转发面板拿到完整兜底字段。
      const timer = setTimeout(() => {
        finishFallback('分享创建超时，将发送默认卡片');
      }, 2800);
      createCoachShare(this.data.currentSessionId, indices, name || undefined)
        .then((res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            title,
            path: `${COACH_SHARE_PAGE}?sid=${res.sid}`,
            ...(shareCoverPath ? { imageUrl: shareCoverPath } : {}),
          });
        })
        .catch((err: unknown) => {
          const detail = err instanceof ApiError && err.detail && err.detail.length <= 20 ? err.detail : '';
          finishFallback(detail ? `分享创建失败：${detail}` : '分享创建失败，将发送默认卡片');
        });
    });
  },

  onMenuTap() {
    // 与会话抽屉互斥（#623 决议）：进抽屉先退出选择模式。
    if (this.data.selectMode) {
      this.exitSelectMode();
      wx.showToast({ title: '已退出多选', icon: 'none' });
    }
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
    projectionLength = 0;
    this.setData({
      sessions,
      currentSessionId: newSession.id,
      messages: welcomeMessages(),
      scrollIntoId: '',
      drawerOpen: false,
      contextHint: '',
      selectMode: false,
      selectCount: 0,
      allSelected: false,
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
