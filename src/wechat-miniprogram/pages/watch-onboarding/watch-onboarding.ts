// 手表绑定引导页 —— 同时是小程序侧的 onboarding 进度页。
//
// 两种形态：
//   1. 还没绑表 → 价值说明 + COROS/Garmin 入口（跳现有手表绑定页 pages/watch，零改动）。
//   2. 已绑表   → 确保有一个 onboarding run 在跑（services/onboarding），展示阶段进度；
//      run 成功后按 profile_ready 分流：去补资料，或直接标记完成。
//
// onShow 必须续跑：onboarding pipeline 生产实测平均 24 分钟（最长 51 分钟），用户不可能在页面里
// 等完，小程序也一定会被杀。所以每次回到这个页面都要接着上次那次 run 继续 —— 本地指针 +
// 服务端 run 都在，不需要从头再来。

import { getWatchInfo } from '../../services/watch';
import {
  completeOnboarding,
  ensureOnboarding,
  getOnboardingStatus,
  retryOnboarding,
  type OnboardingResult,
} from '../../services/onboarding';
import { pollPipeline, type PollPipelineHandle } from '../../services/sync';
import { describeRun } from '../../utils/onboardingSteps';
import { userStore } from '../../store/index';

type Phase =
  | 'loading'
  | 'needsWatch'
  | 'syncing'
  | 'pending' // 轮询超时但 run 还在跑（不是失败）
  | 'needsProfile'
  | 'failed'
  | 'disabled' // 部署开关关掉了 onboarding 同步
  | 'done';

interface WatchOnboardingPageData {
  connected: boolean;
  phase: Phase;
  /** 「第 2/6 步 · 计算能力基线」 */
  stepText: string;
  percent: number;
  errorMsg: string;
}

interface WatchOnboardingPageHandlers {
  onProviderTap(e: WechatMiniprogram.TouchEvent): void;
  goHome(): void;
  onRetry(): Promise<void>;
  onFillProfile(): void;
  refresh(): Promise<void>;
  applyResult(res: OnboardingResult): Promise<void>;
  startPolling(runId: string): void;
  finalize(runId: string): Promise<void>;
  cancelPoll(): void;
  currentUserId(): string;
  /** 轮询句柄存实例上，避免模块级状态在多实例间串扰（同 profile.ts）。 */
  _pollHandle?: PollPipelineHandle;
}

Page<WatchOnboardingPageData, WatchOnboardingPageHandlers>({
  data: {
    connected: false,
    phase: 'loading',
    stepText: '',
    percent: 0,
    errorMsg: '',
  },

  onShow() {
    void this.refresh();
  },

  onUnload() {
    this.cancelPoll();
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

  // 页面每次出现都走这里：查表状态 → 需要的话确保 onboarding 在跑 → 按结果分流。
  async refresh() {
    this.cancelPoll();
    this.setData({ phase: 'loading', errorMsg: '' });

    let connected = false;
    try {
      const info = await getWatchInfo();
      connected = info.logged_in;
    } catch {
      // 查询失败不阻断引导（保持默认态，用户仍可跳过或进入绑定页）—— 与改动前一致
      console.warn('[onboarding] 查询手表状态失败，按未绑表处理');
    }
    this.setData({ connected });
    if (!connected) {
      this.setData({ phase: 'needsWatch' });
      return;
    }

    const userId = this.currentUserId();
    if (!userId) {
      console.warn('[onboarding] 无 userId，跳过 onboarding');
      this.setData({ phase: 'done' });
      return;
    }

    try {
      await this.applyResult(await ensureOnboarding(userId));
    } catch (err) {
      console.error('[onboarding] 初始化失败:', err);
      this.setData({
        phase: 'failed',
        errorMsg: err instanceof Error ? err.message : '同步启动失败，请重试',
      });
    }
  },

  async applyResult(res: OnboardingResult) {
    switch (res.phase) {
      case 'complete':
        this.setData({ phase: 'done' });
        return;
      case 'disabled':
        this.setData({ phase: 'disabled' });
        return;
      // 服务端还没认这块表（watch_ready=false）→ 回绑表引导，别显示"已完成"
      case 'no-watch':
        this.setData({ phase: 'needsWatch' });
        return;
      case 'running':
        if (res.runId) this.startPolling(res.runId);
        return;
      case 'done':
        await this.finalize(res.runId || '');
        return;
      case 'failed':
        this.setData({ phase: 'failed', errorMsg: res.message || '同步失败' });
        return;
    }
  },

  startPolling(runId: string) {
    this.cancelPoll();
    console.log(`[onboarding] 开始轮询 run ${runId}`);
    this.setData({ phase: 'syncing', percent: 0, stepText: '正在准备同步…' });

    const handle = pollPipeline(runId, {
      onProgress: (run) => {
        const p = describeRun(run);
        this.setData({
          stepText: `第 ${p.stepIndex}/${p.stepTotal} 步 · ${p.label}`,
          percent: p.percent,
        });
      },
    });
    this._pollHandle = handle;

    handle.promise
      .then(() => {
        // 句柄已被取代（页面重进/卸载/换 run）→ 这次结果不归我处理
        if (this._pollHandle !== handle) return;
        this._pollHandle = undefined;
        this.setData({ percent: 100 });
        return this.finalize(runId);
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
          this.setData({ phase: 'pending' });
          return;
        }
        console.error('[onboarding] 轮询失败:', msg);
        this.setData({ phase: 'failed', errorMsg: msg });
      });
  },

  // run 已经 done：complete 还要求 profile_ready && watch_ready，所以先看资料齐没齐。
  async finalize(runId: string) {
    this.setData({ phase: 'syncing', percent: 100, stepText: '正在收尾…' });
    try {
      const status = await getOnboardingStatus();
      if (!status.profileReady) {
        // 资料没填 → 去现有资料页。填完回来 onShow 会再走一遍；指针还在，不会重跑 pipeline。
        console.log('[onboarding] run 已完成但资料未就绪 → 引导补资料');
        this.setData({ phase: 'needsProfile' });
        return;
      }
      const userId = this.currentUserId();
      if (!userId || !runId) return;
      await completeOnboarding(userId, runId);
      this.setData({ phase: 'done' });
    } catch (err) {
      console.error('[onboarding] 收尾失败:', err);
      this.setData({
        phase: 'failed',
        errorMsg: err instanceof Error ? err.message : '标记完成失败，请重试',
      });
    }
  },

  async onRetry() {
    const userId = this.currentUserId();
    if (!userId) return;
    this.setData({ phase: 'loading', errorMsg: '' });
    try {
      await this.applyResult(await retryOnboarding(userId));
    } catch (err) {
      console.error('[onboarding] 重试失败:', err);
      this.setData({
        phase: 'failed',
        errorMsg: err instanceof Error ? err.message : '重试失败，请稍后再试',
      });
    }
  },

  onFillProfile() {
    wx.navigateTo({ url: '/pages/profile-edit/profile-edit' });
  },

  onProviderTap(e: WechatMiniprogram.TouchEvent) {
    const provider = e.currentTarget.dataset.provider as string;
    if (provider !== 'coros' && provider !== 'garmin') return;
    // 带上品牌：pages/watch 的 onLoad 会据此直接进登录表单，不再让用户选第二遍
    wx.navigateTo({ url: `/pages/watch/watch?provider=${provider}` });
  },

  // 「稍后再说」与「进入首页」是同一动作：跳过引导 / 离开引导页
  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
