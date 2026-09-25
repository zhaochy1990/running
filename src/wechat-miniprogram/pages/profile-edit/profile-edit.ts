// 个人资料设置页 —— 从「我的」页头像卡进入。
//
// 数据来源拆分（ADR 0013）：
//   - 身份字段（头像 / 昵称 / 邮箱）走 auth-service GET/PATCH /api/users/me；
//   - 身体字段（性别 / 生日 / 身高 / 体重 / 跑步年限）走数据面
//     GET/PATCH/POST /api/users/me/profile。
// profile 尚未建立（GET 返回 null）时，身体段逐字段改动只落本地，底部「保存」
// 走整表 POST；已建立时逐字段 PATCH。
import { userStore } from '../../store/index';
import {
  getMyProfile,
  patchMyProfile,
  postMyProfile,
  updateProfile,
  uploadAvatar,
} from '../../services/profile';
import type { ProfilePatch } from '../../services/profile';
import { ApiError } from '../../services/request';
import { shanghaiToday } from '../../utils/date';
// 取值表与 onboarding 的资料步共用一份（必须与后端 oneof 一致），见 utils/profileFields.ts
import { AGE_OPTIONS, AGE_VALUES, SEX_OPTIONS, SEX_VALUES } from '../../utils/profileFields';
import type { Sex } from '../../utils/profileFields';

interface ProfileEditPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  saving: boolean;
  error: string;
  name: string;
  email: string;
  avatarUrl: string;
  hasProfile: boolean;
  creating: boolean;
  sexIndex: number;
  sexOptions: string[];
  dob: string;
  heightCm: string;
  weightKg: string;
  ageIndex: number;
  ageOptions: string[];
  today: string;
}

interface ProfileEditPageHandlers {
  onBack(): void;
  onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>): void;
  onNameInput(e: WechatMiniprogram.Input): void;
  onSaveName(): void;
  onSexChange(e: { detail: { value: number } }): void;
  onDobChange(e: { detail: { value: string } }): void;
  onHeightInput(e: WechatMiniprogram.Input): void;
  onHeightBlur(): void;
  onWeightInput(e: WechatMiniprogram.Input): void;
  onWeightBlur(): void;
  onAgeChange(e: { detail: { value: number } }): void;
  onStartCreate(): void;
  onSaveBody(): Promise<void>;
  load(): Promise<void>;
  patchField(patch: ProfilePatch): Promise<void>;
  refreshIdentity(): void;
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

// 数据面错误体 {detail, code} 与 auth-service 的 {error, message} 经 ApiError 归一化；
// detail 可能是 FastAPI 校验错误数组，故只接受字符串。
function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (typeof err.detail === 'string' && err.detail) return err.detail;
    if (typeof err.code === 'string' && err.code) return err.code;
  }
  return fallback;
}

Page<ProfileEditPageData, ProfileEditPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    loading: true,
    saving: false,
    error: '',
    name: '',
    email: '',
    avatarUrl: '',
    hasProfile: false,
    creating: false,
    sexIndex: -1,
    sexOptions: SEX_OPTIONS,
    dob: '',
    heightCm: '',
    weightKg: '',
    ageIndex: 0,
    ageOptions: AGE_OPTIONS,
    today: '2100-01-01',
  },

  onLoad() {
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
      today: shanghaiToday(),
    });
  },

  // onShow：返回本页时刷新身份（头像 / 昵称可能已在别处更新）并回读 profile。
  onShow() {
    this.refreshIdentity();
    void this.load();
  },

  refreshIdentity() {
    const user = userStore.getState().user;
    this.setData({
      name: user?.name || '',
      email: user?.email || '',
      avatarUrl: user?.avatar_url || '',
    });
  },

  async load() {
    try {
      const data = await getMyProfile();
      const core = data.profile;
      // 数据面把 sex 回传成 string（不是联合类型），这里的取值来自我们自己提交的
      // token，故收窄回 Sex 用于查下标；未知值 indexOf 仍返回 -1。
      const sexIndex = core ? SEX_VALUES.indexOf(core.sex as Sex) : -1;
      this.setData({
        loading: false,
        error: '',
        hasProfile: !!core,
        creating: false,
        sexIndex,
        dob: core?.dob || '',
        heightCm: core && core.height_cm ? String(core.height_cm) : '',
        weightKg: core && core.weight_kg ? String(core.weight_kg) : '',
        ageIndex: Math.max(0, AGE_VALUES.indexOf(core?.running_age_range || data.running_age_range)),
      });
    } catch (err) {
      this.setData({ loading: false, error: friendlyError(err, '加载资料失败') });
    }
  },

  onBack() {
    wx.navigateBack();
  },

  // 选完头像立即上传并保存（auth-service），不需要额外按钮。
  async onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
    const temp = e.detail.avatarUrl;
    if (!temp || this.data.saving) return;
    this.setData({ saving: true });
    try {
      const avatarUrl = await uploadAvatar(temp);
      const updated = await updateProfile({ avatar_url: avatarUrl });
      userStore.setUser(updated);
      this.setData({ avatarUrl: updated.avatar_url || avatarUrl });
    } catch (err) {
      wx.showToast({ title: friendlyError(err, '头像保存失败'), icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  onNameInput(e: WechatMiniprogram.Input) {
    this.setData({ name: e.detail.value });
  },

  // 昵称失焦自动保存（微信 nickname 输入限制），空值 / 未改动不提交。
  async onSaveName() {
    const name = this.data.name.trim();
    const current = userStore.getState().user?.name || '';
    if (!name || name === current || this.data.saving) return;
    this.setData({ saving: true });
    try {
      const updated = await updateProfile({ name });
      userStore.setUser(updated);
      this.setData({ name: updated.name || name });
    } catch (err) {
      wx.showToast({ title: friendlyError(err, '保存失败'), icon: 'none' });
      this.refreshIdentity();
    } finally {
      this.setData({ saving: false });
    }
  },

  onSexChange(e: { detail: { value: number } }) {
    const index = Number(e.detail.value);
    const value = SEX_VALUES[index];
    if (!value) return;
    this.setData({ sexIndex: index });
    void this.patchField({ sex: value });
  },

  onDobChange(e: { detail: { value: string } }) {
    const dob = e.detail.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return;
    this.setData({ dob });
    void this.patchField({ dob });
  },

  onHeightInput(e: WechatMiniprogram.Input) {
    this.setData({ heightCm: e.detail.value });
  },

  onHeightBlur() {
    const raw = this.data.heightCm.trim();
    const parsed = Number(raw);
    if (!raw || !(parsed > 0)) {
      wx.showToast({ title: '请输入有效身高 (cm)', icon: 'none' });
      if (this.data.hasProfile) void this.load();
      return;
    }
    void this.patchField({ height_cm: parsed });
  },

  onWeightInput(e: WechatMiniprogram.Input) {
    this.setData({ weightKg: e.detail.value });
  },

  onWeightBlur() {
    const raw = this.data.weightKg.trim();
    const parsed = Number(raw);
    if (!raw || !(parsed > 0)) {
      wx.showToast({ title: '请输入有效体重 (kg)', icon: 'none' });
      if (this.data.hasProfile) void this.load();
      return;
    }
    void this.patchField({ weight_kg: parsed });
  },

  onAgeChange(e: { detail: { value: number } }) {
    const index = Number(e.detail.value);
    const value = AGE_VALUES[index];
    if (!value) return;
    this.setData({ ageIndex: index });
    void this.patchField({ running_age_range: value });
  },

  // 未建立 profile：点「完善身体数据」整表入口展开字段，一次 POST 建立。
  onStartCreate() {
    this.setData({ creating: true });
  },

  // 逐字段保存（仅已有 profile）；失败回读服务端值，避免界面停留在未保存状态。
  async patchField(patch: ProfilePatch) {
    if (!this.data.hasProfile || this.data.saving) return;
    this.setData({ saving: true });
    try {
      await patchMyProfile(patch);
    } catch (err) {
      wx.showToast({ title: friendlyError(err, '保存失败'), icon: 'none' });
      await this.load();
    } finally {
      this.setData({ saving: false });
    }
  },

  // 未建立 profile：整表 POST 建立（display_name 取当前昵称）。
  async onSaveBody() {
    if (this.data.saving) return;
    const displayName = this.data.name.trim();
    const sex = SEX_VALUES[this.data.sexIndex];
    const dob = this.data.dob;
    const height = Number(this.data.heightCm);
    const weight = Number(this.data.weightKg);
    if (!displayName || !sex || !dob || !(height > 0) || !(weight > 0)) {
      wx.showToast({ title: '请填写完整资料', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      await postMyProfile({
        display_name: displayName,
        dob,
        sex,
        height_cm: height,
        weight_kg: weight,
        running_age_range: AGE_VALUES[this.data.ageIndex] || 'unknown',
      });
      wx.showToast({ title: '资料已保存', icon: 'success' });
      await this.load();
    } catch (err) {
      wx.showToast({ title: friendlyError(err, '保存失败'), icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
