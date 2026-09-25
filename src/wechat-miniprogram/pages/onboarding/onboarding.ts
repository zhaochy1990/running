// Onboarding 单页三步：资料（必填） → 绑表（可跳过） → 同步（可跳过）。
//
// **完成 onboarding 只发生在第一步**：资料保存成功后立即调 complete（ADR 0013）。
// 后两步是可选动作 —— 跳过它们不影响"已完成"，只影响有没有数据可看。
//
// 落点每次 onShow 重算，所以续跑是天然的：小程序必然会在 24 分钟的同步中途被杀，
// 每次回来都按 profile_ready / watch_ready 重新落到该去的那一步。
// 资料已齐但完成标记没写上（比如上次 complete 请求失败）会补一次，自愈。

import {
  completeOnboarding,
  ensureSync,
  getOnboardingStatus,
  retrySync,
  type SyncResult,
} from '../../services/onboarding';
import { postMyProfile, updateProfile, uploadAvatar } from '../../services/profile';
import { watchLogin, type WatchProvider } from '../../services/watch';
import { pollPipeline, type PollPipelineHandle } from '../../services/sync';
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
import { userStore } from '../../store/index';

type Step = 'loading' | 'profile' | 'watch' | 'sync' | 'ready';

const REGION_OPTIONS = ['中国区', '国际区'];

interface OnboardingPageData {
  step: Step;
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
}

interface OnboardingPageHandlers {
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
  /** 轮询句柄存实例上，避免模块级状态在多实例间串扰（同 profile.ts）。 */
  _pollHandle?: PollPipelineHandle;
}

Page<OnboardingPageData, OnboardingPageHandlers>({
  data: {
    step: 'loading',
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

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  // 唯一的落点决策：每次进页面都按服务端状态重算该停在哪一步。
  async refresh() {
    this.cancelPoll();
    this.setData({ step: 'loading', formError: '', watchError: '', syncError: '' });

    let status: Awaited<ReturnType<typeof getOnboardingStatus>>;
    try {
      status = await getOnboardingStatus();
    } catch (err) {
      console.error('[onboarding] 读取状态失败:', err);
      this.setData({ step: 'profile', formError: '加载失败，请检查网络后重试' });
      return;
    }

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
      await this.applySyncResult(await ensureSync(userId));
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
    const userId = this.currentUserId();
    if (!userId) return;
    this.setData({ syncError: '', syncPending: false });
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
