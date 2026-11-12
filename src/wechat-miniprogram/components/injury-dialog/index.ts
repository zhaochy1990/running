// 伤病弹层（#858 PR-E）—— 两种形态共用一套外壳：
//   mode='enter'  伤病登记（调整弹窗「受伤了」路径进入 / 加重重判复用）：
//                 detail 多行输入 + 四选一 → 抛 entered {detail, verdict}
//   mode='ask'    每日轻问（pages/index onShow / 训练计划页提示条触发）：
//                 checkin 四键（好转/持平/加重/恢复了）→ 抛 checked {answer}
//                 doctor 三键（pending_doctor）→ 抛 doctored {verdict}
//                 verdict 四选一（needs_verdict 加重后，enter 覆盖）→ 抛 entered
// 交互形态由父页传入的 injury 行经 utils/injuryFlow.injuryAskKind 派生，
// 组件不直接调 service（父页统一发请求并把结果文本经 resultText 属性回填，
// 弹层进入 result 态显示文案 +「知道了」关闭）。
//
// rest 态 + 比赛临近（≤4 周）时父页把 raceClosingSoon=true 传入，
// 轻问底部附「比赛临近，也可以按现状重排整个计划」+「找教练聊聊」入口。
//
// 事件：
//   bindentered   detail = { detail, verdict }   登记四选一（enter 覆盖同款）
//   bindchecked   detail = { answer }            每日轻问四键
//   binddoctored  detail = { verdict }           医生结论三键
//   bindcoach     无 detail                        「找教练聊聊」→ 父页跳教练 tab
//   bindclosed    无 detail                        关闭

import {
  INJURY_CHECKIN_OPTIONS,
  INJURY_DOCTOR_OPTIONS,
  INJURY_VERDICT_OPTIONS,
  type InjuryAskKind,
  injuryAskKind,
  injuryAskQuestion,
} from '../../utils/injuryFlow';
import type { InjuryCheckinOption, InjuryDoctorOption, InjuryVerdictOption } from '../../utils/injuryFlow';
import type { InjuryVerdict, PlanInjuryState } from '../../types/adjustment';

type InjuryDialogMode = 'enter' | 'ask' | 'result';

interface InjuryDialogData {
  /** 视图形态：enter 登记表单 / ask 轻问 / result 结果文案。 */
  view: InjuryDialogMode;
  /** ask 形态的问句分支（父页的 injury 行派生，父页也可直传覆盖）。 */
  askKind: InjuryAskKind | null;
  question: string;
  checkinOptions: InjuryCheckinOption[];
  doctorOptions: InjuryDoctorOption[];
  verdictOptions: InjuryVerdictOption[];
  detailInput: string;
  detailPlaceholder: string;
  selected: string;
  submitting: boolean;
  resultText: string;
}

/** 组件属性定义（Component 第二泛型收窄 this.properties 的值类型）。 */
type InjuryDialogProps = {
  show: { type: BooleanConstructor; value: boolean };
  /** enter=登记表单；ask=每日轻问（父页不再另设 result 入口，结果经 resultText 回填切换）。 */
  mode: { type: StringConstructor; value: InjuryDialogMode };
  injury: { type: ObjectConstructor; value: PlanInjuryState | null };
  /** rest + 比赛临近：轻问附「按现状重排」行 + 教练入口。 */
  raceClosingSoon: { type: BooleanConstructor; value: boolean };
  /** 父页请求成功后的结果文案（回填即切 result 态展示）。 */
  resultText: { type: StringConstructor; value: string };
};

type InjuryDialogMethods = {
  noop(): void;
  onClose(): void;
  onDetailInput(e: WechatMiniprogram.CustomEvent): void;
  onVerdictTap(e: WechatMiniprogram.TouchEvent): void;
  onSubmitEnter(): void;
  onCheckinTap(e: WechatMiniprogram.TouchEvent): void;
  onDoctorTap(e: WechatMiniprogram.TouchEvent): void;
  onCoachTap(): void;
  onResultCloseTap(): void;
};

/** 实例字段（非渲染数据）：本组件无定时器类实例态，占位保持泛型形状一致。 */
interface InjuryDialogInstance {}

const DETAIL_PLACEHOLDER = '哪里伤 / 现在什么感觉？一句话就行，教练会看';

Component<InjuryDialogData, InjuryDialogProps, InjuryDialogMethods, [], InjuryDialogInstance>({
  properties: {
    show: { type: Boolean, value: false },
    mode: { type: String, value: 'enter' },
    injury: { type: Object, value: null },
    raceClosingSoon: { type: Boolean, value: false },
    resultText: { type: String, value: '' },
  },

  data: {
    view: 'enter',
    askKind: null,
    question: '',
    checkinOptions: [...INJURY_CHECKIN_OPTIONS] as InjuryCheckinOption[],
    doctorOptions: [...INJURY_DOCTOR_OPTIONS] as InjuryDoctorOption[],
    verdictOptions: [...INJURY_VERDICT_OPTIONS] as InjuryVerdictOption[],
    detailInput: '',
    detailPlaceholder: DETAIL_PLACEHOLDER,
    selected: '',
    submitting: false,
    resultText: '',
  },

  observers: {
    // 打开 / 行刷新：按 mode 组装视图。ask 形态的问句分支由 injury 行派生；
    // verdict 分支（加重重判）复用 enter 表单（detail 预填上一轮登记）。
    'show, mode, injury': function reset(show: boolean, mode: InjuryDialogMode, injury: PlanInjuryState | null) {
      if (!show) return;
      if (mode === 'ask') {
        const kind = injuryAskKind(injury);
        this.setData({
          view: 'ask',
          askKind: kind,
          question: kind ? injuryAskQuestion(kind) : '',
          detailInput: kind === 'verdict' ? (injury?.detail ?? '') : '',
          selected: '',
          submitting: false,
        });
        return;
      }
      this.setData({
        view: 'enter',
        question: '伤的情况是？',
        detailInput: '',
        selected: '',
        submitting: false,
      });
    },

    // 父页回填结果文案 → 切 result 态（enter/checkin/doctor 成功后的差异化文案）。
    resultText(text: string) {
      if (!text || !this.data.show) return;
      this.setData({ view: 'result', submitting: false });
    },
  },

  methods: {
    noop() {},

    onClose() {
      this.triggerEvent('closed');
    },

    onDetailInput(e: WechatMiniprogram.CustomEvent) {
      this.setData({ detailInput: String(e.detail.value ?? '') });
    },

    onVerdictTap(e: WechatMiniprogram.TouchEvent) {
      const value = e.currentTarget.dataset.value as string | undefined;
      if (!value || this.data.submitting) return;
      this.setData({ selected: value });
    },

    // 登记提交（enter / verdict 重判共用）：detail 必填（后端 required），四选一必选。
    onSubmitEnter() {
      const detail = this.data.detailInput.trim();
      const selected = this.data.selected as InjuryVerdict | '';
      if (this.data.submitting) return;
      if (!detail) {
        wx.showToast({ title: '先简单说一句哪里伤', icon: 'none' });
        return;
      }
      if (!selected) {
        wx.showToast({ title: '选一下现在的情况', icon: 'none' });
        return;
      }
      this.setData({ submitting: true });
      this.triggerEvent('entered', { detail, verdict: selected });
    },

    // 每日轻问四键：直接抛给父页发 checkin。
    onCheckinTap(e: WechatMiniprogram.TouchEvent) {
      const answer = e.currentTarget.dataset.value as string | undefined;
      if (!answer || this.data.submitting) return;
      this.setData({ submitting: true });
      this.triggerEvent('checked', { answer });
    },

    // 医生三键：抛给父页发 doctor。
    onDoctorTap(e: WechatMiniprogram.TouchEvent) {
      const verdict = e.currentTarget.dataset.value as string | undefined;
      if (!verdict || this.data.submitting) return;
      this.setData({ submitting: true });
      this.triggerEvent('doctored', { verdict });
    },

    // 「找教练聊聊」：父页跳教练 tab（switchTab 不能带 query，交给父页处理）。
    onCoachTap() {
      this.triggerEvent('coach');
    },

    onResultCloseTap() {
      this.triggerEvent('closed');
    },
  },
})
