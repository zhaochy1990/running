// 自定义比赛全屏表单页 ——「我的比赛」顶栏「＋」（新建）与卡上「···→编辑」（回显）进入。
// 必填仅 名称 / 日期（#456 定稿放宽）；类型七值 chips 默认越野跑，选越野/超长越野
// 高亮建议填 D+；日期无上限（过去 = 补录、远未来均可，#457 修正决议）。
// 保存走 services/custom-races；成功返回列表页，列表 onShow 聚合刷新。
// 编辑回显数据由列表页经 navigateTo eventChannel 传入（#457：回显走聚合的全字段）。

import {
  createCustomRace,
  updateCustomRace,
  type CustomRace,
  type CustomRaceBody,
  type CustomRaceState,
} from '../../services/custom-races';
import { CUSTOM_TYPE_CHIPS } from '../../utils/myRaceRows';

type TypeChips = Array<{ token: string; label: string; on: boolean }>;

function chipsWithOn(token: string): TypeChips {
  return CUSTOM_TYPE_CHIPS.map((chip) => ({ ...chip, on: chip.token === token }));
}

interface CustomRaceFormPageData {
  saving: boolean;
  /** 0 = 新建；>0 = 编辑该 id */
  editingId: number;
  name: string;
  date: string;
  typeChips: TypeChips;
  typeToken: string;
  dist: string;
  ascent: string;
  city: string;
  website: string;
  note: string;
  state: CustomRaceState;
  /** 越野跑 / 超长越野：高亮建议填 D+ */
  isTrail: boolean;
}

interface CustomRaceFormPageHandlers {
  onNameInput(e: WechatMiniprogram.Input): void;
  onDateChange(e: { detail: { value: string } }): void;
  onTypeTap(e: WechatMiniprogram.TouchEvent): void;
  onDistInput(e: WechatMiniprogram.Input): void;
  onAscentInput(e: WechatMiniprogram.Input): void;
  onCityInput(e: WechatMiniprogram.Input): void;
  onWebsiteInput(e: WechatMiniprogram.Input): void;
  onNoteInput(e: WechatMiniprogram.Input): void;
  onStateTap(e: WechatMiniprogram.TouchEvent): void;
  onSave(): Promise<void>;
}

function toast(msg: string): void {
  wx.showToast({ title: msg, icon: 'none' });
}

Page<CustomRaceFormPageData, CustomRaceFormPageHandlers>({
  data: {
    saving: false,
    editingId: 0,
    name: '',
    date: '',
    typeChips: chipsWithOn('Trail'),
    typeToken: 'Trail',
    dist: '',
    ascent: '',
    city: '',
    website: '',
    note: '',
    state: 'want',
    isTrail: true,
  },

  onLoad() {
    // 编辑回显：列表页 navigateTo success 里 eventChannel.emit('race', 全字段行)。
    // 新建进入时无该事件，保持默认空表单（标题用 json 里的「添加自定义比赛」）。
    const channel = this.getOpenerEventChannel?.();
    channel?.on?.('race', (race: CustomRace) => {
      wx.setNavigationBarTitle({ title: '编辑自定义比赛' });
      this.setData({
        editingId: race.id,
        name: race.name,
        date: race.race_date,
        typeChips: chipsWithOn(race.item_type),
        typeToken: race.item_type,
        dist: race.distance_km != null ? String(race.distance_km) : '',
        ascent: race.ascent_m != null ? String(race.ascent_m) : '',
        city: race.city,
        website: race.website,
        note: race.note,
        state: race.state,
        isTrail: race.item_type === 'Trail' || race.item_type === 'Ultra',
      });
    });
  },

  onNameInput(e: WechatMiniprogram.Input) {
    this.setData({ name: e.detail.value });
  },

  onDateChange(e: { detail: { value: string } }) {
    this.setData({ date: e.detail.value });
  },

  onTypeTap(e: WechatMiniprogram.TouchEvent) {
    const token = String(e.currentTarget.dataset.token);
    if (!token || token === this.data.typeToken) return;
    this.setData({
      typeToken: token,
      typeChips: chipsWithOn(token),
      isTrail: token === 'Trail' || token === 'Ultra',
    });
  },

  onDistInput(e: WechatMiniprogram.Input) {
    this.setData({ dist: e.detail.value });
  },

  onAscentInput(e: WechatMiniprogram.Input) {
    this.setData({ ascent: e.detail.value });
  },

  onCityInput(e: WechatMiniprogram.Input) {
    this.setData({ city: e.detail.value });
  },

  onWebsiteInput(e: WechatMiniprogram.Input) {
    this.setData({ website: e.detail.value });
  },

  onNoteInput(e: WechatMiniprogram.Input) {
    this.setData({ note: e.detail.value });
  },

  onStateTap(e: WechatMiniprogram.TouchEvent) {
    const state = e.currentTarget.dataset.state as CustomRaceState;
    if (state !== 'want' && state !== 'registered') return;
    this.setData({ state });
  },

  async onSave() {
    if (this.data.saving) return;
    const name = this.data.name.trim();
    if (!name) {
      toast('请填写比赛名称');
      return;
    }
    const date = this.data.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      toast('请选择比赛日期');
      return;
    }
    const dist = this.data.dist.trim();
    let distanceKm: number | null = null;
    if (dist !== '') {
      distanceKm = Number(dist);
      if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
        toast('距离需为正数（km）');
        return;
      }
      if (distanceKm > 99999.9) {
        toast('距离上限 99999.9 km');
        return;
      }
    }
    const ascent = this.data.ascent.trim();
    let ascentM: number | null = null;
    if (ascent !== '') {
      const n = Number(ascent);
      if (!Number.isInteger(n) || n < 0) {
        toast('爬升需为非负整数（m）');
        return;
      }
      ascentM = n;
    }
    // PUT 是全量更新（缺省可选字段会被清空），可选项显式带 null/空串即可
    const body: CustomRaceBody = {
      name,
      race_date: date,
      item_type: this.data.typeToken,
      distance_km: distanceKm,
      ascent_m: ascentM,
      city: this.data.city.trim(),
      website: this.data.website.trim(),
      note: this.data.note.trim(),
      state: this.data.state,
    };
    this.setData({ saving: true });
    try {
      if (this.data.editingId) await updateCustomRace(this.data.editingId, body);
      else await createCustomRace(body);
      wx.navigateBack();
    } catch (err: unknown) {
      this.setData({ saving: false });
      toast(err instanceof Error ? err.message : '保存失败，请稍后重试');
    }
  },
});
