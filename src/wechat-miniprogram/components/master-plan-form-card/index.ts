// 赛季训练计划创建表单卡（#1024 R2）——聊天里的可编辑表单卡。
//
// 服务端 training 节点做一次快 LLM 槽位补全，把预填表单挂在回复消息的
// additional_kwargs.card（$type=master-plan-form）上；本组件按卡片 data
// 渲染双 tab 表单（比赛目标 / 训练安排），内部维护可编辑副本（不回写原卡
// data），提交时校验完整性并抛 submit，由 coach 页组装 kernel request 投
// plan-jobs。卡头文案（图标/标题/副标题/角标）由 utils/coachCards 注册表
// 产出，父页以属性传入。
//
// 键盘：输入框在聊天气泡的 scroll-view 内。input 均为原生受控组件，
// 保留 adjust-position 默认值（键盘顶起时页面整体上移）；真机走查若发现
// 键盘遮挡，降级方案见 #1024（摘要行 + 点开半屏面板）。
//
// 事件：
//   bindsubmit  detail = { form, options }   校验通过后的完整表单

import type { MasterPlanFormCard, Weekday } from '../../services/master-plan';
import { DEFAULT_MASTER_PLAN_FORM_OPTIONS, isValidPlanTargetTime, type MasterPlanFormOptions, type MasterPlanFormValues } from '../../utils/planJobCards';
import { WEEKDAY_VALUES } from '../../utils/weekday';
import { pad2, shanghaiToday } from '../../utils/date';

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const DISTANCE_OPTIONS = ['全程马拉松（全马）', '半程马拉松（半马）'];
const LONG_RUN_NO_PREFERENCE = '不指定';
// 目标成绩契约允许一至两位小时数，0 小时也可输入半马成绩。
const HOUR_OPTIONS = ['请选择', ...Array.from({ length: 100 }, (_, hour) => String(hour))];
const ZERO_TO_59 = Array.from({ length: 60 }, (_, i) => i);
const STRENGTH_OPTIONS = ['不安排', '1 次', '2 次', '3 次'];

interface DayChip {
  value: Weekday;
  label: string;
  selected: boolean;
}

interface TargetTimeParts {
  hour: number;
  minute: number;
  second: number;
}

interface FormCardData {
  activeTab: 'goal' | 'train';
  raceName: string;
  distanceIndex: number;
  distanceOptions: string[];
  raceDate: string;
  todayYmd: string;
  targetHourIndex: number;
  targetHour: number | null;
  targetMinute: number;
  targetSecond: number;
  hourOptions: string[];
  targetTimeError: string;
  minuteRange: number[];
  secondRange: number[];
  dayChips: DayChip[];
  longRunIndex: number;
  longRunOptions: string[];
  base: string;
  restriction: string;
  errorRaceName: boolean;
  /** 比赛日期错误文案（空 = 无错误）：必填/格式/必须在今天之后。 */
  raceDateError: string;
  errorDays: boolean;
  /** 长跑日必须落在已选训练日里。 */
  longRunError: string;
  // —— 更多选项（#1030：kernel request 里会实际约束排课的两项）——
  optionsExpanded: boolean;
  allowsDoubleSessions: boolean;
  strengthOptions: string[];
  strengthIndex: number;
  strengthDayChips: DayChip[];
  strengthDaysError: string;
  submitted: boolean;
}

type FormCardProps = {
  icon: { type: StringConstructor; value: string };
  title: { type: StringConstructor; value: string };
  subtitle: { type: StringConstructor; value: string };
  badge: { type: StringConstructor; value: string };
  form: { type: ObjectConstructor; value: MasterPlanFormCard | null };
};

interface FormCardInstance {
  /** 已 hydrate 的卡片签名：父页重渲染但卡片数据没变时不清掉用户正在填的内容。 */
  _formSignature: string;
}

type FormCardMethods = {
  hydrate(form: MasterPlanFormCard | null, rememberSource?: boolean): void;
  onTabTap(e: WechatMiniprogram.TouchEvent): void;
  onRaceNameInput(e: WechatMiniprogram.CustomEvent): void;
  onDistanceChange(e: WechatMiniprogram.PickerChange): void;
  onDateChange(e: WechatMiniprogram.PickerChange): void;
  onHourChange(e: WechatMiniprogram.PickerChange): void;
  onMinuteChange(e: WechatMiniprogram.PickerChange): void;
  onSecondChange(e: WechatMiniprogram.PickerChange): void;
  onDayTap(e: WechatMiniprogram.TouchEvent): void;
  onLongRunChange(e: WechatMiniprogram.PickerChange): void;
  onBaseInput(e: WechatMiniprogram.CustomEvent): void;
  onRestrictionInput(e: WechatMiniprogram.CustomEvent): void;
  // 更多选项（#1030）
  onToggleOptions(): void;
  onStrengthChange(e: WechatMiniprogram.PickerChange): void;
  onStrengthDayTap(e: WechatMiniprogram.TouchEvent): void;
  onDoubleToggle(): void;
  onSubmitTap(): void;
  /** 父页投递失败时回退到可编辑态（保留用户已填内容）。 */
  submitFailed(): void;
  /** 「修改目标」：从上次提交的值开始编辑。 */
  reopenForm(values?: MasterPlanFormValues): void;
};

/** 组件 property 传参时数组可能被序列化成数字键对象（开发者工具实测），
 *  统一归一化成数组再迭代。 */
function toWeekdayArray(value: unknown): Weekday[] {
  const items = Array.isArray(value) ? value : value != null && typeof value === 'object' ? Object.values(value) : [];
  return items.filter((item): item is Weekday => typeof item === 'string' && (WEEKDAY_VALUES as readonly string[]).includes(item));
}

function parseTargetTime(value: string): TargetTimeParts | null {
  const targetTime = value.trim();
  if (!isValidPlanTargetTime(targetTime)) return null;
  const [hour, minute, second] = targetTime.split(':').map(Number);
  return { hour, minute, second };
}

/** 卡片 data 的稳定签名（observer 判断「真的换了卡片」）。 */
function formSignature(form: MasterPlanFormCard): string {
  return JSON.stringify([form.goal, form.availability, form.base, form.restriction]);
}

Component<FormCardData, FormCardProps, FormCardMethods, [], FormCardInstance>({
  properties: {
    icon: { type: String, value: '' },
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    badge: { type: String, value: '' },
    form: { type: Object, value: null },
  },

  data: {
    activeTab: 'goal',
    raceName: '',
    distanceIndex: 0,
    distanceOptions: DISTANCE_OPTIONS,
    raceDate: '',
    todayYmd: '',
    targetHourIndex: 0,
    targetHour: null,
    targetMinute: 0,
    targetSecond: 0,
    hourOptions: HOUR_OPTIONS,
    targetTimeError: '',
    minuteRange: ZERO_TO_59,
    secondRange: ZERO_TO_59,
    dayChips: WEEKDAY_VALUES.map((value, index) => ({ value, label: WEEKDAY_LABELS[index], selected: false })),
    optionsExpanded: false,
    allowsDoubleSessions: DEFAULT_MASTER_PLAN_FORM_OPTIONS.allows_double_sessions,
    strengthOptions: STRENGTH_OPTIONS,
    strengthIndex: DEFAULT_MASTER_PLAN_FORM_OPTIONS.strength_sessions_per_week,
    strengthDayChips: WEEKDAY_VALUES.map((value, index) => ({
      value,
      label: WEEKDAY_LABELS[index],
      selected: (DEFAULT_MASTER_PLAN_FORM_OPTIONS.strength_available_days as readonly Weekday[]).includes(value),
    })),
    strengthDaysError: '',
    longRunIndex: 0,
    longRunOptions: [LONG_RUN_NO_PREFERENCE, ...WEEKDAY_VALUES.map((_, index) => `周${WEEKDAY_LABELS[index]}`)],
    base: '',
    restriction: '',
    errorRaceName: false,
    raceDateError: '',
    errorDays: false,
    longRunError: '',
    submitted: false,
  },

  observers: {
    form: function hydrateOnForm(form: MasterPlanFormCard | null) {
      if (!form) return;
      // 只在卡片数据真的变化时重填，避免父页无关 setData 清掉用户输入。
      if (formSignature(form) === this._formSignature) return;
      this.hydrate(form);
    },
  },

  lifetimes: {
    attached() {
      this.setData({ todayYmd: shanghaiToday() });
      this.hydrate(this.properties.form);
    },
  },

  methods: {
    /** 卡片 data → 可编辑副本（字段空串按「待填写」保留）。
     *  已提交态不随父页重渲染复位（重填只走 reopenForm，父页显式触发）。 */
    hydrate(form: MasterPlanFormCard | null, rememberSource = true) {
      if (!form) return;
      const time = parseTargetTime(form.goal.target_time);
      if (rememberSource) this._formSignature = formSignature(form);
      const preferred = form.availability.preferred_long_run_day;
      const weeklyDays = toWeekdayArray(form.availability.weekly_days);
      const selected = new Set(weeklyDays);
      const hour = time?.hour ?? null;
      this.setData({
        activeTab: 'goal',
        raceName: form.goal.race_name,
        distanceIndex: form.goal.distance === 'HM' ? 1 : 0,
        raceDate: form.goal.race_date,
        targetHourIndex: hour === null ? 0 : hour + 1,
        targetHour: hour,
        targetMinute: time?.minute ?? 0,
        targetSecond: time?.second ?? 0,
        targetTimeError: '',
        dayChips: WEEKDAY_VALUES.map((value, index) => ({
          value,
          label: WEEKDAY_LABELS[index],
          selected: selected.has(value),
        })),
        longRunIndex: preferred && selected.has(preferred) ? WEEKDAY_VALUES.indexOf(preferred) + 1 : 0,
        base: form.base,
        restriction: form.restriction,
        errorRaceName: false,
        raceDateError: '',
        errorDays: false,
        longRunError: '',
      });
    },

    onTabTap(e: WechatMiniprogram.TouchEvent) {
      const tab = e.currentTarget.dataset.tab as 'goal' | 'train' | undefined;
      if (tab !== 'goal' && tab !== 'train') return;
      this.setData({ activeTab: tab });
    },

    onRaceNameInput(e: WechatMiniprogram.CustomEvent) {
      this.setData({ raceName: String(e.detail.value ?? ''), errorRaceName: false });
    },

    onDistanceChange(e: WechatMiniprogram.PickerChange) {
      this.setData({ distanceIndex: Number(e.detail.value) || 0 });
    },

    onDateChange(e: WechatMiniprogram.PickerChange) {
      this.setData({ raceDate: String(e.detail.value ?? ''), raceDateError: '' });
    },

    onHourChange(e: WechatMiniprogram.PickerChange) {
      const index = Number(e.detail.value) || 0;
      const hour = this.data.hourOptions[index];
      if (hour === undefined) return;
      this.setData({ targetHour: index === 0 ? null : Number(hour), targetHourIndex: index, targetTimeError: '' });
    },

    onMinuteChange(e: WechatMiniprogram.PickerChange) {
      this.setData({ targetMinute: Number(e.detail.value) || 0, targetTimeError: '' });
    },

    onSecondChange(e: WechatMiniprogram.PickerChange) {
      this.setData({ targetSecond: Number(e.detail.value) || 0, targetTimeError: '' });
    },

    onDayTap(e: WechatMiniprogram.TouchEvent) {
      const value = e.currentTarget.dataset.value as Weekday | undefined;
      if (!value) return;
      this.setData({
        dayChips: this.data.dayChips.map((chip) => (chip.value === value ? { ...chip, selected: !chip.selected } : chip)),
        errorDays: false,
        longRunError: '',
      });
    },

    onLongRunChange(e: WechatMiniprogram.PickerChange) {
      this.setData({ longRunIndex: Number(e.detail.value) || 0, longRunError: '' });
    },

    onToggleOptions() {
      this.setData({ optionsExpanded: !this.data.optionsExpanded });
    },

    onStrengthChange(e: WechatMiniprogram.PickerChange) {
      this.setData({ strengthIndex: Number(e.detail.value) || 0, strengthDaysError: '' });
    },

    onStrengthDayTap(e: WechatMiniprogram.TouchEvent) {
      const value = e.currentTarget.dataset.value as Weekday | undefined;
      if (!value) return;
      this.setData({
        strengthDayChips: this.data.strengthDayChips.map((chip) =>
          chip.value === value ? { ...chip, selected: !chip.selected } : chip,
        ),
        strengthDaysError: '',
      });
    },

    onDoubleToggle() {
      this.setData({ allowsDoubleSessions: !this.data.allowsDoubleSessions });
    },

    onBaseInput(e: WechatMiniprogram.CustomEvent) {
      this.setData({ base: String(e.detail.value ?? '') });
    },

    onRestrictionInput(e: WechatMiniprogram.CustomEvent) {
      this.setData({ restriction: String(e.detail.value ?? '') });
    },

    /** 提交：必填（赛事名 / 比赛日期 / 目标成绩 / 至少一个训练日）校验 → 抛 submit。 */
    onSubmitTap() {
      if (this.data.submitted) return;
      const raceName = this.data.raceName.trim();
      const raceDate = this.data.raceDate;
      const trainingDays = this.data.dayChips.filter((chip) => chip.selected).map((chip) => chip.value);
      const errorRaceName = raceName.length === 0;
      const raceDateError =
        raceDate.length === 0
          ? '请选择比赛日期'
          : !/^\d{4}-\d{2}-\d{2}$/.test(raceDate)
            ? '比赛日期格式不正确'
            : raceDate < this.data.todayYmd
              ? '请选择今天之后的比赛日期'
              : '';
      const { targetHour, targetMinute, targetSecond } = this.data;
      const targetTime = targetHour === null ? '' : [targetHour, pad2(targetMinute), pad2(targetSecond)].join(':');
      const targetTimeError = isValidPlanTargetTime(targetTime) ? '' : '请选择有效的目标成绩';
      const errorDays = trainingDays.length === 0;
      // 长跑日必须落在已选训练日里，否则请求会自相矛盾（unavailable_days 含它）。
      const longRunDay = this.data.longRunIndex > 0 ? WEEKDAY_VALUES[this.data.longRunIndex - 1] : null;
      const longRunError = longRunDay && !trainingDays.includes(longRunDay) ? '长跑日需要选在可训练日里' : '';
      const strengthDays = this.data.strengthDayChips.filter((chip) => chip.selected).map((chip) => chip.value);
      const strengthDaysError =
        this.data.strengthIndex === 0
          ? ''
          : strengthDays.length === 0
            ? '请选择力量训练日'
            : strengthDays.length < this.data.strengthIndex
              ? '力量训练日数量不少于每周次数'
              : '';
      if (errorRaceName || raceDateError || targetTimeError || errorDays || longRunError || strengthDaysError) {
        this.setData({
          errorRaceName,
          raceDateError,
          targetTimeError,
          errorDays,
          longRunError,
          strengthDaysError,
          optionsExpanded: strengthDaysError ? true : this.data.optionsExpanded,
          activeTab: errorRaceName || raceDateError || targetTimeError ? 'goal' : 'train',
        });
        wx.showToast({ title: '请先补齐必填项', icon: 'none' });
        return;
      }
      const form: MasterPlanFormCard = {
        goal: {
          race_name: raceName,
          distance: this.data.distanceIndex === 1 ? 'HM' : 'FM',
          race_date: raceDate,
          target_time: targetTime,
        },
        availability: {
          weekly_days: trainingDays,
          preferred_long_run_day: longRunDay,
        },
        base: this.data.base.trim(),
        restriction: this.data.restriction.trim(),
      };
      const options: MasterPlanFormOptions = {
        allows_double_sessions: this.data.allowsDoubleSessions,
        strength_sessions_per_week: this.data.strengthIndex,
        strength_available_days: this.data.strengthIndex > 0 ? strengthDays : [],
      };
      this.setData({ submitted: true });
      this.triggerEvent('submit', { form, options });
    },

    submitFailed() {
      this.setData({ submitted: false });
    },

    reopenForm(values?: MasterPlanFormValues) {
      if (values) {
        this.hydrate(values.form, false);
        const { options } = values;
        this.setData({
          allowsDoubleSessions: options.allows_double_sessions,
          strengthIndex: options.strength_sessions_per_week,
          strengthDayChips: this.data.strengthDayChips.map((chip) => ({
            ...chip,
            selected: options.strength_available_days.includes(chip.value),
          })),
          strengthDaysError: '',
        });
      }
      this.setData({ submitted: false, activeTab: 'goal' });
    },
  },
});
