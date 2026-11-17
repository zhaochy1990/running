// Onboarding 单页三步：资料（必填） → 绑表（可跳过） → 同步（可跳过）。
//
// **完成 onboarding 只发生在第一步**：资料保存成功后立即调 complete（ADR 0013）。
// 后两步是可选动作 —— 跳过它们不影响"已完成"，只影响有没有数据可看。
//
// 落点每次 onShow 重算，所以续跑是天然的：小程序必然会在长时间同步中途被杀，
// 每次回来都按 profile_ready / watch_ready 重新落到该去的那一步。
// 资料已齐但完成标记没写上（比如上次 complete 请求失败）会补一次，自愈。
//
// 同步步有两条互斥路径（devops#1015 / epic devops#1004），由 profile features
// 双开关决定（见 services/onboarding-sync.ts 与 services/onboarding.ts 头注释）：
//   - session（新）：POST 创建/认领可靠后即进首页，进度交首页状态卡，不等同步。
//   - legacy（旧 full-run）：本地指针 + 认领别端 run + 幂等键，页面轮询到终态。

import {
  completeOnboarding,
  ensureSync,
  getOnboardingStatus,
  retrySync,
  type SyncResult,
} from '../../services/onboarding';
import {
  createOrClaimOnboardingSyncSession,
  getOnboardingSyncSession,
  isNoWatchProvider,
  isSessionEntryUnavailable,
  retryOnboardingSyncSession,
  type OnboardingSyncView,
} from '../../services/onboarding-sync';
import { postMyProfile, updateProfile, uploadAvatar } from '../../services/profile';
import { watchLogin, type WatchProvider } from '../../services/watch';
import { pollPipeline, type PollPipelineHandle } from '../../services/sync';
import { SESSION_POLL_MS, sessionStepTexts } from '../../utils/onboardingSession';
import { describeRun } from '../../utils/onboardingSteps';
import {
  AGE_OPTIONS,
  AGE_VALUES,
  SEX_OPTIONS,
  SEX_VALUES,
  missingProfileFields,
  type ProfileInput,
} from '../../utils/profileFields';
import { shanghaiToday } from '../../utils/date';
import { logger } from '../../utils/logger';
import { sanitizeRedirect } from '../../utils/redirect';
import { userStore } from '../../store/index';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

type Step = 'loading' | 'profile' | 'watch' | 'sync' | 'ready';

/** 同步步的入口模式：session（新，双开关开）或 legacy（旧 full-run，兼容路径）。 */
type SyncMode = 'legacy' | 'session';

/** session 模式的提交阶段：creating = POST 创建/认领中；adopting = 等 shell_ready（接管在途旧 run）。 */
type SessionPhase = 'creating' | 'adopting';

const REGION_OPTIONS = ['中国区', '国际区'];

interface OnboardingPageData {
  step: Step;
  /** 同步入脚模式（refresh 时按 features 双开关决定；session 提交中 403 会切回 legacy）。 */
  syncMode: SyncMode;
  // —— 资料步 ——
  avatarUrl: string;
  nickname: string;
  sexIndex: number;
  sexOptions: string[];
  dob: string;
  today: string;
  heightCm: string;
  weightKg: string;
  ageIndex: number;
  ageOptions: string[];
  saving: boolean;
  formError: string;
  // —— 绑表步 ——
  provider: WatchProvider | null;
  email: string;
  password: string;
  regionIndex: number;
  regionOptions: string[];
  connecting: boolean;
  watchError: string;
  // —— 同步步 ——
  syncText: string;
  percent: number;
  syncError: string;
  /** 轮询到达上限但 run 还在跑（不是失败） */
  syncPending: boolean;
  // —— session 模式提交步文案（sessionStepTexts 产出，WXML 只渲染不拼逻辑）——
  sessionTitle: string;
  sessionSubtitle: string;
  sessionProgressText: string;
  /** 失败时的重试按钮文案；进行中为空串（按钮不渲染） */
  sessionRetryLabel: string;
}

interface OnboardingPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onShow(): void;
  onUnload(): void;
  refresh(): Promise<void>;
  // 资料步
  onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>): Promise<void>;
  onNicknameInput(e: WechatMiniprogram.Input): void;
  onSexChange(e: { detail: { value: number } }): void;
  onDobChange(e: { detail: { value: string } }): void;
  onHeightInput(e: WechatMiniprogram.Input): void;
  onWeightInput(e: WechatMiniprogram.Input): void;
  onAgeChange(e: { detail: { value: number } }): void;
  onSaveProfile(): Promise<void>;
  markComplete(): Promise<void>;
  // 绑表步
  onSelectProvider(e: WechatMiniprogram.TouchEvent): void;
  onEmailInput(e: WechatMiniprogram.Input): void;
  onPasswordInput(e: WechatMiniprogram.Input): void;
  onRegionChange(e: { detail: { value: number } }): void;
  onConnect(): Promise<void>;
  onSkipWatch(): void;
  // 同步步
  applySyncResult(res: SyncResult): Promise<void>;
  startPolling(runId: string): void;
  onRetrySync(): Promise<void>;
  cancelPoll(): void;
  currentUserId(): string;
  goHome(): void;
  // session 模式
  applySessionSync(retry?: boolean): Promise<void>;
  applyLegacySync(): Promise<void>;
  waitForSessionShellReady(): void;
  cancelSessionPoll(): void;
  enterHomeAfterSession(): void;
  applySessionStepTexts(phase: SessionPhase, errorMode: 'create' | 'sync', hasError: boolean): void;

  /** 轮询句柄存实例上，避免模块级状态在多实例间串扰（同 profile.ts）。 */
  _pollHandle?: PollPipelineHandle;
  /** session shell_ready 轮询定时器（session 模式没有 run 指针，只有这一个 timer）。 */
  _sessionTimer?: ReturnType<typeof setTimeout> | null;
  /** session 轮询代数：新的 applySessionSync / cancelSessionPoll 使旧的异步链失效。 */
  _sessionGen?: number;
  /** 登录流程带回的回跳目标（sanitizeRedirect 已校验），空/undefined = 默认回 coach 首页 */
  _redirect?: string;
}

Page<OnboardingPageData, OnboardingPageHandlers>({
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,
  data: {
    step: 'loading',
    syncMode: 'legacy',
    avatarUrl: '',
    nickname: '',
    sexIndex: 0,
    sexOptions: SEX_OPTIONS,
    dob: '',
    today: shanghaiToday(),
    heightCm: '',
    weightKg: '',
    ageIndex: 0,
    ageOptions: AGE_OPTIONS,
    saving: false,
    formError: '',
    provider: null,
    email: '',
    password: '',
    regionIndex: 0,
    regionOptions: REGION_OPTIONS,
    connecting: false,
    watchError: '',
    syncText: '',
    percent: 0,
    syncError: '',
    syncPending: false,
    sessionTitle: '',
    sessionSubtitle: '',
    sessionProgressText: '',
    sessionRetryLabel: '',
  },

  onLoad(options: Record<string, string | undefined>) {
    this._redirect = sanitizeRedirect(options.redirect);
  },

  onShow() {
    void this.refresh();
  },

  onUnload() {
    this.cancelPoll();
    this.cancelSessionPoll();
  },

  currentUserId(): string {
    return userStore.getState().user?.id || '';
  },

  cancelPoll() {
    if (this._pollHandle) {
      this._pollHandle.cancel();
      this._pollHandle = undefined;
    }
  },

  cancelSessionPoll() {
    // 代数 +1 让在途 GET 的回调作废；timer 清掉轮询即停。
    this._sessionGen = (this._sessionGen || 0) + 1;
    if (this._sessionTimer) {
      clearTimeout(this._sessionTimer);
      this._sessionTimer = null;
    }
  },

  goHome() {
    // 从登录流程带 redirect 进来时优先回跳目标页（issue #702）
    if (this._redirect) {
      wx.reLaunch({ url: this._redirect });
      return;
    }
    wx.switchTab({ url: '/pages/coach/coach' });
  },

  // 唯一的落点决策：每次进页面都按服务端状态重算该停在哪一步。
  async refresh() {
    this.cancelPoll();
    this.cancelSessionPoll();
    this.setData({ step: 'loading', formError: '', watchError: '', syncError: '' });

    let status: Awaited<ReturnType<typeof getOnboardingStatus>>;
    try {
      status = await getOnboardingStatus();
    } catch (err) {
      console.error('[onboarding] 读取状态失败:', err);
      this.setData({ step: 'profile', formError: '加载失败，请检查网络后重试' });
      return;
    }

    // 入口模式由服务端双开关决定（features 回显），页面只跟随不缓存：
    // 开关翻转后的下一次进页面自然切到对应路径。
    this.setData({ syncMode: status.sessionMode ? 'session' : 'legacy' });

    if (!status.profileReady) {
      this.setData({ step: 'profile' });
      return;
    }
    // 资料齐了但完成标记没写上（上次 complete 失败 / 在别的端没走完）→ 补一次，自愈。
    if (!status.completed) {
      await this.markComplete();
    }
    if (!status.watchReady) {
      this.setData({ step: 'watch' });
      return;
    }

    const userId = this.currentUserId();
    if (!userId) {
      this.setData({ step: 'ready' });
      return;
    }
    if (status.sessionMode) {
      await this.applySessionSync();
      return;
    }
    await this.applyLegacySync();
  },

  // --- 资料步 ---

  async onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
    const temp = e.detail.avatarUrl;
    if (!temp || this.data.saving) return;
    this.setData({ saving: true, formError: '' });
    try {
      // 头像二进制走 COS，库里只存 URL（AGENTS.md 存储范围规则）；与资料页同一条路径。
      const url = await uploadAvatar(temp);
      await updateProfile({ avatar_url: url });
      this.setData({ avatarUrl: url, saving: false });
      console.log('[onboarding] 微信头像已上传');
    } catch (err) {
      logger.error('avatar save fail (onboarding)', err instanceof Error ? err.message : String(err));
      this.setData({
        saving: false,
        formError: err instanceof Error ? err.message : '头像上传失败',
      });
    }
  },

  onNicknameInput(e: WechatMiniprogram.Input) {
    this.setData({ nickname: e.detail.value, formError: '' });
  },

  onSexChange(e: { detail: { value: number } }) {
    this.setData({ sexIndex: Number(e.detail.value) || 0, formError: '' });
  },

  onDobChange(e: { detail: { value: string } }) {
    this.setData({ dob: e.detail.value, formError: '' });
  },

  onHeightInput(e: WechatMiniprogram.Input) {
    this.setData({ heightCm: e.detail.value, formError: '' });
  },

  onWeightInput(e: WechatMiniprogram.Input) {
    this.setData({ weightKg: e.detail.value, formError: '' });
  },

  onAgeChange(e: { detail: { value: number } }) {
    this.setData({ ageIndex: Number(e.detail.value) || 0, formError: '' });
  },

  async onSaveProfile() {
    if (this.data.saving) return;
    const input: ProfileInput = {
      display_name: this.data.nickname.trim(),
      dob: this.data.dob,
      sex: SEX_VALUES[this.data.sexIndex],
      height_cm: Number(this.data.heightCm),
      weight_kg: Number(this.data.weightKg),
      running_age_range: AGE_VALUES[this.data.ageIndex] || 'unknown',
    };
    const missing = missingProfileFields(input);
    if (missing.length) {
      this.setData({ formError: `还差：${missing.join('、')}` });
      return;
    }

    this.setData({ saving: true, formError: '' });
    try {
      // 整表 POST：数据面建立 profile（并置 profile_ready），顺带把 display_name
      // 镜像到 auth-service 的 name（ADR 0013）。
      await postMyProfile(input);
      console.log('[onboarding] 资料已保存');
      await this.markComplete();
      // 重新算落点：正常进绑表步；若其实已经绑过表，会直接落到同步步。
      await this.refresh();
    } catch (err) {
      console.error('[onboarding] 保存资料失败:', err);
      this.setData({
        saving: false,
        formError: err instanceof Error ? err.message : '保存失败，请重试',
      });
      return;
    }
    this.setData({ saving: false });
  },

  // 完成只依赖资料，且服务端幂等。失败不打断流程（进页面时会重试）—— 但必须留痕，
  // 否则"填了资料却没完成"会变成静默故障。
  async markComplete() {
    try {
      await completeOnboarding();
    } catch (err) {
      console.error('[onboarding] 标记完成失败（下次进页面会重试）:', err);
    }
  },

  // --- 绑表步 ---

  onSelectProvider(e: WechatMiniprogram.TouchEvent) {
    const provider = e.currentTarget.dataset.provider as WatchProvider;
    if (provider !== 'coros' && provider !== 'garmin') return;
    this.setData({ provider, watchError: '' });
  },

  onEmailInput(e: WechatMiniprogram.Input) {
    this.setData({ email: e.detail.value, watchError: '' });
  },

  onPasswordInput(e: WechatMiniprogram.Input) {
    this.setData({ password: e.detail.value, watchError: '' });
  },

  onRegionChange(e: { detail: { value: number } }) {
    this.setData({ regionIndex: Number(e.detail.value) || 0, watchError: '' });
  },

  async onConnect() {
    const { provider, email, password, connecting } = this.data;
    if (connecting) return;
    if (!provider) {
      this.setData({ watchError: '请先选择手表品牌' });
      return;
    }
    if (!email.trim() || !password.trim()) {
      this.setData({ watchError: '请填写账号与密码' });
      return;
    }

    this.setData({ connecting: true, watchError: '' });
    try {
      await watchLogin(
        provider,
        email.trim(),
        password,
        this.data.regionIndex === 1 ? 'global' : 'cn',
      );
      console.log('[onboarding] 手表绑定成功');
      wx.showToast({ title: '绑定成功', icon: 'success' });
      this.setData({ connecting: false, password: '' });
      const userId = this.currentUserId();
      if (!userId) {
        this.setData({ step: 'ready' });
        return;
      }
      if (this.data.syncMode === 'session') {
        await this.applySessionSync();
        return;
      }
      await this.applyLegacySync();
    } catch (err) {
      this.setData({
        connecting: false,
        watchError: err instanceof Error ? err.message : '绑定失败，请重试',
      });
    }
  },

  onSkipWatch() {
    this.goHome();
  },

  // --- 同步步 ---

  // session 模式（devops#1015）：POST 创建/认领 → shell_ready 后 profile-only 完成
  // 进首页。没有本地指针与幂等键：同绑定多端并发 POST 解析到同一 session，杀进程 /
  // 换设备 / 重新登录后再来一次也只是认领，不会重复起 full。创建失败如实报错，
  // 不假报「后台正在同步」。retry=true 走显式重试：只重新派发失败项，已成功范围
  // 服务端复用凭据不重拉。
  async applySessionSync(retry = false) {
    this.cancelSessionPoll();
    this.cancelPoll();
    this.setData({
      step: 'sync',
      syncMode: 'session',
      syncError: '',
      syncPending: false,
      syncText: '',
      percent: 0,
    });
    this.applySessionStepTexts('creating', retry ? 'sync' : 'create', false);

    let view: OnboardingSyncView;
    try {
      view = retry ? await retryOnboardingSyncSession() : await createOrClaimOnboardingSyncSession();
    } catch (err) {
      if (isSessionEntryUnavailable(err)) {
        // 读 profile 与提交之间开关被关：入口对该客户端已不存在 → 旧流程接管。
        console.warn('[onboarding] session 入口不可用（开关关闭/未接线），回退旧 full-run 流程');
        await this.applyLegacySync();
        return;
      }
      if (isNoWatchProvider(err)) {
        // 能力标志不满足（绑表状态在提交前变了）→ 回绑表步。
        this.setData({ step: 'watch' });
        return;
      }
      console.error('[onboarding] 创建/重试同步 session 失败:', err);
      const errorMode = retry ? 'sync' : 'create';
      this.applySessionStepTexts('creating', errorMode, true);
      this.setData({ syncError: retry ? '重试失败，请稍后再试' : '同步任务创建失败，请重试' });
      return;
    }

    if (view.shell_ready) {
      this.enterHomeAfterSession();
      return;
    }
    // shell_ready=false（waiting_legacy：服务端在接管在途的旧 full run）不是失败：
    // 轮询只读视图直到 session 与可靠派发记录都已持久化，再进首页。
    this.applySessionStepTexts('adopting', 'create', false);
    this.waitForSessionShellReady();
  },

  // session 提交步文案统一从这里出（sessionStepTexts 纯函数，自检覆盖）。
  applySessionStepTexts(phase: SessionPhase, errorMode: 'create' | 'sync', hasError: boolean) {
    const texts = sessionStepTexts(phase, errorMode, hasError);
    this.setData({
      sessionTitle: texts.title,
      sessionSubtitle: texts.subtitle,
      sessionProgressText: texts.progressText,
      sessionRetryLabel: texts.retryLabel,
    });
  },

  // 旧 full-run 路径（开关关闭时的兼容行为，语义与 devops#1015 之前完全一致）。
  async applyLegacySync() {
    this.cancelSessionPoll();
    this.setData({ syncMode: 'legacy', syncError: '', syncPending: false });
    const userId = this.currentUserId();
    if (!userId) {
      this.setData({ step: 'ready' });
      return;
    }
    try {
      await this.applySyncResult(await ensureSync(userId));
    } catch (err) {
      console.error('[onboarding] 启动同步失败:', err);
      this.setData({
        step: 'sync',
        syncError: err instanceof Error ? err.message : '同步启动失败，请重试',
      });
    }
  },

  waitForSessionShellReady() {
    const gen = this._sessionGen || 0;
    const tick = async () => {
      if ((this._sessionGen || 0) !== gen) return; // 已被新的提交/卸载取代
      try {
        const view = await getOnboardingSyncSession();
        if ((this._sessionGen || 0) !== gen) return;
        if (view.shell_ready) {
          this.enterHomeAfterSession();
          return;
        }
        if (view.state === 'failed') {
          // 接管期间链路判了失败：如实展示（区别于创建失败），重试走 retry 只恢复失败项。
          console.error('[onboarding] session 接管期间失败:', view.error);
          this.applySessionStepTexts('adopting', 'sync', true);
          this.setData({ syncError: view.error || '同步失败，请重试' });
          return;
        }
      } catch (err) {
        if ((this._sessionGen || 0) !== gen) return;
        // 暂时性错误继续等；入口被关掉则交回旧流程（它会重算落点）。
        if (isSessionEntryUnavailable(err)) {
          console.warn('[onboarding] 等 shell_ready 期间入口被关闭，回退旧流程');
          await this.applyLegacySync();
          return;
        }
        console.warn('[onboarding] 查询 session 状态暂时失败，继续轮询');
      }
      this._sessionTimer = setTimeout(() => void tick(), SESSION_POLL_MS);
    };
    void tick();
  },

  enterHomeAfterSession() {
    this.cancelSessionPoll();
    // profile-only 完成在 refresh()/保存资料时已做（幂等、自愈），新 run 从不交给
    // 旧完成验证 —— 这里直接按既有安全 redirect 语义进首页。
    this.goHome();
  },

  async applySyncResult(res: SyncResult) {
    switch (res.phase) {
      case 'disabled':
      case 'done':
        this.setData({ step: 'ready' });
        return;
      case 'no-watch':
        this.setData({ step: 'watch' });
        return;
      case 'running':
        if (res.runId) this.startPolling(res.runId);
        return;
      case 'failed':
        this.setData({ step: 'sync', syncError: res.message || '同步失败' });
        return;
    }
  },

  startPolling(runId: string) {
    this.cancelPoll();
    console.log(`[onboarding] 开始轮询 run ${runId}`);
    this.setData({ step: 'sync', percent: 0, syncText: '正在准备同步…', syncError: '', syncPending: false });

    const handle = pollPipeline(runId, {
      onProgress: (run) => {
        const p = describeRun(run);
        this.setData({
          syncText: `第 ${p.stepIndex}/${p.stepTotal} 步 · ${p.label}`,
          percent: p.percent,
        });
      },
    });
    this._pollHandle = handle;

    handle.promise
      .then(() => {
        if (this._pollHandle !== handle) return; // 已被新的轮询/卸载取代
        this._pollHandle = undefined;
        this.setData({ percent: 100, step: 'ready' });
      })
      .catch((err: unknown) => {
        if (this._pollHandle !== handle) return;
        this._pollHandle = undefined;
        const msg = err instanceof Error ? err.message : '同步失败';
        if (msg === 'cancelled') return;
        // 60 分钟轮询上限不是失败：pipeline 还在跑（生产最长见过 51 分钟）。
        // 让用户先走，下次进页面靠本地指针接着续跑。
        if (msg === '同步超时') {
          console.warn('[onboarding] 轮询到达上限，run 仍在跑，交给下次续跑');
          this.setData({ syncPending: true, syncText: '还在同步中' });
          return;
        }
        console.error('[onboarding] 同步失败:', msg);
        this.setData({ syncError: msg });
      });
  },

  async onRetrySync() {
    this.setData({ syncError: '', syncPending: false });
    // session 模式：显式重试（POST retry:true）——已成功的范围服务端复用凭据，
    // 只重新派发失败项；创建失败场景没有 session，服务端会退化为一次创建。
    if (this.data.syncMode === 'session') {
      await this.applySessionSync(true);
      return;
    }
    const userId = this.currentUserId();
    if (!userId) return;
    try {
      await this.applySyncResult(await retrySync(userId));
    } catch (err) {
      console.error('[onboarding] 重试失败:', err);
      this.setData({
        syncError: err instanceof Error ? err.message : '重试失败，请稍后再试',
      });
    }
  },
});
