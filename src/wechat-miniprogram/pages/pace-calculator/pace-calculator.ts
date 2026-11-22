import { fetchPaceRaceTemplates, type PaceRaceTemplate } from '../../services/pace-calculator';
import {
  applyRaceTemplate, calculate, decodeCalculation, encodeCalculation, HALF_MARATHON_KM,
  MARATHON_KM, MAX_SEGMENTS, type Calculation, type PaceResult, type PaceSegment, type QuickMode,
} from '../../utils/paceCalculator';
import { BUILTIN_PACE_RACE_TEMPLATES } from '../../services/pace-race-templates-data';
import { shanghaiDateFromIso } from '../../utils/date';
import { renderPaceCard } from '../../utils/paceCard';
import { saveImageToAlbum } from '../../utils/saveImage';

const PAGE = '/pages/pace-calculator/pace-calculator';
const FAVORITES_KEY = 'stride.pace-calculator.favorites.v1';
const MAX_FAVORITES = 20;

function toast(title: string) {
  wx.showToast({ title, icon: 'none' });
}

interface Favorite {
  id: string;
  name: string;
  calculation: Calculation;
}

type FavoriteRow = Favorite & { summary: string; date: string; splits: PaceResult['checkpoints'] };
type SegmentRow = PaceSegment & { id: number };
type SplitView = 'rows' | 'checkpoints' | 'kilometers';
type InputEvent = WechatMiniprogram.CustomEvent<{ value: string }>;

function favoriteRows(favorites: Favorite[]): FavoriteRow[] {
  return favorites.flatMap((favorite) => {
    const calculated = calculate(favorite.calculation);
    if ('error' in calculated) return [];
    const { distance, time, pace } = calculated.result;
    const date = shanghaiDateFromIso(new Date(Number(favorite.id)).toISOString());
    return [{ ...favorite, summary: `${distance} · ${time} · ${pace}`, date, splits: calculated.result.checkpoints }];
  });
}

let nextSegmentId = 0;

function segmentRows(segments: PaceSegment[]): SegmentRow[] {
  return segments.map(({ end, pace, note, terrain }) => ({
    id: nextSegmentId++, end, pace, note: note || '', terrain: terrain || '',
  }));
}

function templateOptions(templates: PaceRaceTemplate[]): string[] {
  return ['请选择赛事', ...templates.map(({ name }) => name)];
}

function cleanSegments(): PaceSegment[] {
  return [{ end: '5', pace: '5:00' }, { end: '', pace: '5:00' }];
}

function presetSegments(distance: number): PaceSegment[] {
  const points = [5, 10, 15, 20, 25, 30, 35, 40].filter((point) => point < distance);
  return [...points, distance].map((end) => ({ end: String(end), pace: '5:00' }));
}

Page({
  data: {
    tab: 'segment' as 'segment' | 'quick',
    modes: [{ key: 'pace', label: '求配速' }, { key: 'time', label: '求用时' }, { key: 'distance', label: '求距离' }],
    quickMode: 'pace' as QuickMode,
    presets: [
      { label: '全马', km: '42.195' }, { label: '半马', km: '21.0975' }, { label: '10K', km: '10' },
      { label: '5K', km: '5' }, { label: '1 英里', km: '1.609344' }, { label: '800 米', km: '0.8' },
    ],
    distance: String(MARATHON_KM),
    time: '3:30:00',
    pace: '5:00',
    segments: segmentRows(cleanSegments()),
    maxSegments: MAX_SEGMENTS,
    templates: BUILTIN_PACE_RACE_TEMPLATES,
    templateIndex: 0,
    templateOptions: templateOptions(BUILTIN_PACE_RACE_TEMPLATES),
    selectedTemplate: null as PaceRaceTemplate | null,
    templatesLoading: false,
    templatesError: false,
    targetTime: '3:30:00',
    targetPresets: ['3:00:00', '3:30:00', '4:00:00', '4:30:00', '5:00:00'],
    result: null as PaceResult | null,
    calculation: null as Calculation | null,
    splitView: 'rows' as SplitView,
    error: '',
    favorites: [] as FavoriteRow[],
    showFavorites: false,
    expandedFavoriteId: '',
    showCard: false,
    cardTitle: '',
    cardMessage: '',
    cardImage: '',
    cardBusy: false,
  },

  onLoad(options) {
    try {
      const saved = wx.getStorageSync<Favorite[]>(FAVORITES_KEY);
      if (Array.isArray(saved)) this.setData({ favorites: favoriteRows(saved) });
    } catch {
      toast('读取收藏失败');
    }
    if (options.share) {
      const shared = decodeCalculation(options.share);
      if (!shared || !this.restoreCalculation(shared)) {
        this.setData({ error: '分享的方案无法打开，可以重新计算' });
      }
    }
    void this.loadTemplates();
  },

  onReady() {
    if (this.data.result) this.scrollToResult();
  },

  scrollToResult() {
    wx.nextTick(() => wx.pageScrollTo({ selector: '#pace-result', duration: 200 }));
  },

  async loadTemplates() {
    if (this.data.templatesLoading) return;
    this.setData({ templatesLoading: true, templatesError: false });
    try {
      const templates = await fetchPaceRaceTemplates();
      const templateIndex = templates.findIndex(({ key }) => key === this.data.selectedTemplate?.key) + 1;
      this.setData({
        templates,
        templateOptions: templateOptions(templates),
        templateIndex,
        selectedTemplate: templates[templateIndex - 1] ?? null,
      });
    } catch {
      this.setData({ templatesError: true });
    } finally {
      this.setData({ templatesLoading: false });
    }
  },

  onTabTap(e: WechatMiniprogram.TouchEvent) {
    const tab = e.currentTarget.dataset.tab as 'segment' | 'quick';
    if (tab !== this.data.tab) this.setData({ tab, result: null, calculation: null, error: '' });
  },

  onQuickModeTap(e: WechatMiniprogram.TouchEvent) {
    const quickMode = e.currentTarget.dataset.mode as QuickMode;
    if (quickMode !== this.data.quickMode) this.setData({ quickMode, result: null, calculation: null, error: '' });
  },

  onInput(e: InputEvent) {
    const field = e.currentTarget.dataset.field as 'distance' | 'time' | 'pace' | 'targetTime';
    if (field === 'targetTime') {
      this.setData({ targetTime: e.detail.value, error: '' });
      return;
    }
    this.setData({ [field]: e.detail.value, result: null, calculation: null, error: '' });
  },

  onDistanceTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ distance: e.currentTarget.dataset.km as string, result: null, calculation: null, error: '' });
  },

  onTemplateChange(e: InputEvent) {
    const templateIndex = Number(e.detail.value);
    this.setData({ templateIndex, selectedTemplate: this.data.templates[templateIndex - 1] ?? null, error: '' });
  },

  onTargetTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ targetTime: e.currentTarget.dataset.time as string, error: '' });
  },

  onApplyTemplate() {
    const { selectedTemplate, targetTime } = this.data;
    if (!selectedTemplate) {
      this.setData({ error: '请先选择赛事模板' });
      return;
    }
    const segments = applyRaceTemplate(selectedTemplate, targetTime);
    if (!segments) {
      this.setData({ error: '请输入 2 至 8 小时的目标用时，例如 3:30:00' });
      return;
    }
    this.updateSegments(segmentRows(segments));
    toast('已填充分段，可以调整后计算');
  },

  updateSegments(segments: SegmentRow[]) {
    this.setData({ segments, result: null, calculation: null, error: '' });
  },

  onFillSegments(e: WechatMiniprogram.TouchEvent) {
    const type = e.currentTarget.dataset.type;
    const segments = type === 'reset'
      ? cleanSegments()
      : presetSegments(type === 'full' ? MARATHON_KM : HALF_MARATHON_KM);
    this.updateSegments(segmentRows(segments));
  },

  onSegmentInput(e: InputEvent) {
    const { index, field } = e.currentTarget.dataset as { index: number; field: 'end' | 'pace' };
    const value = e.detail.value;
    const current = this.data.segments[index];
    if (!current || current[field] === value) return;
    const segments = this.data.segments.map((segment, i) => {
      const updated = i === index ? { ...segment, [field]: value } : segment;
      // Changing an endpoint also moves the start of the following segment.
      return field === 'end' && (i === index || i === index + 1)
        ? { ...updated, note: '', terrain: '' }
        : updated;
    });
    this.updateSegments(segments);
  },

  onAddSegment() {
    if (this.data.segments.length >= MAX_SEGMENTS) return;
    const last = this.data.segments[this.data.segments.length - 1];
    this.updateSegments([...this.data.segments, ...segmentRows([{ end: '', pace: last.pace }])]);
  },

  onRemoveSegment(e: WechatMiniprogram.TouchEvent) {
    if (this.data.segments.length <= 1) return;
    const index = Number(e.currentTarget.dataset.index);
    const segments = this.data.segments
      .filter((_, i) => i !== index)
      .map((segment, i) => i === index ? { ...segment, note: '', terrain: '' } : segment);
    this.updateSegments(segments);
  },

  onCalculate() {
    const { tab, quickMode, segments, distance, time, pace } = this.data;
    if (this.restoreCalculation(tab === 'segment'
      ? { mode: 'segment', segments }
      : { mode: quickMode, distance, time, pace }, true)) {
      this.scrollToResult();
    }
  },

  restoreCalculation(calculation: Calculation, keepSegmentIds = false): boolean {
    const calculated = calculate(calculation);
    if ('error' in calculated) {
      this.setData({ result: null, calculation: null, error: calculated.error });
      return false;
    }
    if (calculation.mode === 'segment') {
      this.setData({ tab: 'segment', segments: keepSegmentIds ? this.data.segments : segmentRows(calculation.segments), splitView: 'rows' });
    } else {
      this.setData({
        tab: 'quick', quickMode: calculation.mode, splitView: 'checkpoints',
        distance: calculation.distance || this.data.distance,
        time: calculation.time || this.data.time,
        pace: calculation.pace || this.data.pace,
      });
    }
    this.setData({ result: calculated.result, calculation, error: '' });
    return true;
  },

  onSplitTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ splitView: e.currentTarget.dataset.split as SplitView });
  },

  onToggleFavorites() {
    this.setData({ showFavorites: !this.data.showFavorites });
  },

  onToggleFavoriteDetails(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as string;
    this.setData({ expandedFavoriteId: this.data.expandedFavoriteId === id ? '' : id });
  },

  persistFavorites(favorites: Favorite[]) {
    try {
      const stored = favorites.map(({ id, name, calculation }) => ({ id, name, calculation }));
      wx.setStorageSync(FAVORITES_KEY, stored);
      this.setData({ favorites: favoriteRows(stored), showFavorites: true });
    } catch {
      toast('更新收藏失败，请重试');
    }
  },

  onSaveFavorite() {
    const { calculation, result } = this.data;
    if (!calculation || !result) return;
    if (this.data.favorites.length >= MAX_FAVORITES) {
      toast('最多收藏 20 个方案，请先删除旧方案');
      return;
    }
    wx.showModal({
      title: '收藏配速方案',
      editable: true,
      placeholderText: `${result.distance} · ${result.time}`,
      confirmText: '收藏',
      success: (res) => {
        if (!res.confirm || this.data.favorites.length >= MAX_FAVORITES) return;
        const name = Array.from(res.content?.trim() || `${result.distance} · ${result.time}`).slice(0, 24).join('');
        this.persistFavorites([{ id: String(Date.now()), name, calculation }, ...this.data.favorites]);
      },
    });
  },

  onLoadFavorite(e: WechatMiniprogram.TouchEvent) {
    const favorite = this.data.favorites.find(({ id }) => id === e.currentTarget.dataset.id);
    if (favorite && this.restoreCalculation(favorite.calculation)) {
      this.scrollToResult();
    }
  },

  onDeleteFavorite(e: WechatMiniprogram.TouchEvent) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除这个收藏？',
      confirmText: '删除',
      success: ({ confirm }) => {
        if (confirm) this.persistFavorites(this.data.favorites.filter((favorite) => favorite.id !== id));
      },
    });
  },

  onOpenCard() {
    this.setData({ showCard: true, cardImage: '', cardTitle: '', cardMessage: '' });
    void this.onGenerateCard();
  },

  onCloseCard() {
    if (!this.data.cardBusy) this.setData({ showCard: false });
  },

  onCardInput(e: InputEvent) {
    const field = e.currentTarget.dataset.field as 'cardTitle' | 'cardMessage';
    this.setData({ [field]: e.detail.value, cardImage: '' });
  },

  async onGenerateCard() {
    const { result, cardBusy, cardTitle, cardMessage } = this.data;
    if (!result || cardBusy) return;
    this.setData({ cardBusy: true, cardImage: '' });
    try {
      this.setData({ cardImage: await renderPaceCard(result, cardTitle.trim(), cardMessage.trim()) });
    } catch {
      toast('配速卡生成失败，请重试');
    } finally {
      this.setData({ cardBusy: false });
    }
  },

  async onSaveCard() {
    if (!this.data.cardImage) return;
    const status = await saveImageToAlbum(this.data.cardImage);
    if (status === 'saved') toast('已保存到相册');
    if (status === 'failed') toast('保存失败，请重试');
  },

  onShareAppMessage() {
    const { calculation, result } = this.data;
    return calculation && result
      ? { title: `配速方案 · ${result.distance} · ${result.time}`, path: `${PAGE}?share=${encodeCalculation(calculation)}` }
      : { title: '砺跑 · 配速计算器', path: PAGE };
  },
});
