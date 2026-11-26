import { getManualStrengthRecord, saveManualStrengthRecord } from '../../services/manual-strength';
import { ApiError } from '../../services/request';
import { userStore } from '../../store/index';
import type { ManualStrengthWrite } from '../../types/manual-strength';
import {
  clearStrengthDraft,
  copySet,
  editStrengthDraft,
  getStrengthDraft,
  LOAD_LABELS,
  LOAD_UNITS,
  matchesStrengthWrite,
  newAction,
  newSet,
  newStrengthDraft,
  newStrengthId,
  QUANTITY_LABELS,
  QUANTITY_UNITS,
  setStrengthDraft,
  settleStrengthDraft,
  validateStrengthForm,
  type ActionForm,
  type StrengthDraft,
  type StrengthForm,
} from '../../utils/manual-strength';

interface PageData {
  loading: boolean;
  loadError: string;
  saving: boolean;
  saved: boolean;
  draft: StrengthDraft | null;
  expanded: string;
  focusField: string;
  invalidField: string;
  error: string;
  loadLabels: readonly string[];
  quantityLabels: readonly string[];
}

interface PageHandlers {
  userId: string;
  unsubscribeViewer: (() => void) | null;
  editing: boolean;
  closed: boolean;
  replaceForm(form: StrengthForm, expanded?: string): void;
  persistDraft(draft: StrengthDraft): void;
  onTextInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
  onFieldFocus(e: WechatMiniprogram.CustomEvent): void;
  onFieldBlur(e: WechatMiniprogram.CustomEvent): void;
  onActionToggle(e: WechatMiniprogram.TouchEvent): void;
  onActionAdd(): void;
  onActionRemove(e: WechatMiniprogram.TouchEvent): void;
  onSetChange(e: WechatMiniprogram.TouchEvent): void;
  onUnitChange(e: WechatMiniprogram.CustomEvent<{ value: string | number }>): void;
  onSave(): Promise<void>;
  commitDraft(draft: StrengthDraft, write: ManualStrengthWrite): Promise<StrengthDraft>;
  resolveConflict(draft: StrengthDraft): Promise<StrengthDraft>;
}

function editSets(
  actions: ActionForm[],
  actionKey: string,
  update: (sets: ActionForm['sets']) => ActionForm['sets'],
): ActionForm[] {
  return actions.map((action) => action.key === actionKey ? { ...action, sets: update(action.sets) } : action);
}

Page<PageData, PageHandlers>({
  userId: '',
  unsubscribeViewer: null,
  editing: false,
  closed: false,
  data: {
    loading: true,
    loadError: '',
    saving: false,
    saved: false,
    draft: null,
    expanded: '',
    focusField: '',
    invalidField: '',
    error: '',
    loadLabels: LOAD_LABELS,
    quantityLabels: QUANTITY_LABELS,
  },

  async onLoad(options) {
    const startedAt = new Date();
    const editId = options.edit || '';
    await userStore.waitForAuth();
    const { user, isAuthenticated } = userStore.getState();
    if (this.closed) return;
    if (!user || !isAuthenticated) {
      this.setData({ loading: false, loadError: '登录后即可记录力量训练' });
      return;
    }
    this.userId = user.id;
    this.unsubscribeViewer = userStore.subscribe((current) => {
      if (current.isAuthenticated && current.user?.id === this.userId) return;
      this.closed = true;
      this.unsubscribeViewer?.();
      this.unsubscribeViewer = null;
      wx.disableAlertBeforeUnload();
      this.setData({
        draft: null, loading: false, saving: false, saved: false,
        expanded: '', focusField: '', invalidField: '', error: '',
        loadError: '当前账号已退出或切换，请重新打开训练记录',
      });
    });
    try {
      const active = getStrengthDraft(user.id);
      let draft: StrengthDraft;
      if (!editId) {
        draft = active ?? await newStrengthDraft(startedAt);
      } else {
        let resume = false;
        if (active?.id === editId) {
          const choice = await wx.showModal({
            title: '这次训练有未保存的内容',
            content: '可以继续录入，或放弃草稿后编辑已保存的记录。',
            confirmText: '继续录入',
            cancelText: '放弃草稿',
          });
          resume = choice.confirm;
          if (!resume) clearStrengthDraft(user.id, editId);
        }
        if (active && resume) {
          draft = active;
        } else {
          draft = editStrengthDraft(await getManualStrengthRecord(user.id, editId));
          this.editing = true;
          wx.setNavigationBarTitle({ title: '编辑力量训练' });
        }
      }
      if (this.closed) return;
      this.setData({ draft, expanded: draft.form.actions[0]?.key ?? '', loading: false });
    } catch {
      if (!this.closed) this.setData({ loading: false, loadError: '暂时无法打开记录，请返回后重试' });
    }
  },

  onUnload() {
    this.closed = true;
    this.unsubscribeViewer?.();
    this.unsubscribeViewer = null;
  },

  persistDraft(draft) {
    if (!this.editing) {
      try {
        setStrengthDraft(this.userId, draft);
      } catch {
        if (!this.closed) {
          this.setData({ error: '草稿暂时无法保存在设备上，请先保存记录' });
        }
      }
    }
  },

  replaceForm(form, expanded) {
    const draft = this.data.draft;
    if (!draft || this.data.saving) return;
    const updated = { ...draft, form };
    this.setData({ draft: updated, expanded: expanded ?? this.data.expanded, saved: false, error: '', invalidField: '' });
    if (this.editing) {
      wx.enableAlertBeforeUnload({ message: '本次修改尚未保存，确定离开吗？' });
    } else {
      this.persistDraft(updated);
    }
  },

  onTextInput(e) {
    const form = this.data.draft?.form;
    if (!form || this.data.saving) return;
    const { field, action, set } = e.currentTarget.dataset;
    const value = e.detail.value;
    if (field === 'name' || field === 'note') {
      this.replaceForm({ ...form, [field]: value });
    } else if (field === 'actionName') {
      this.replaceForm({
        ...form,
        actions: form.actions.map((item) => item.key === action ? { ...item, name: value } : item),
      });
    } else if (field === 'load' || field === 'quantity') {
      this.replaceForm({
        ...form,
        actions: editSets(form.actions, action, (sets) =>
          sets.map((row) => row.key === set ? { ...row, [field]: value } : row)),
      });
    }
  },

  onFieldFocus(e) {
    this.setData({ focusField: e.currentTarget.id });
  },

  onFieldBlur(e) {
    if (this.data.focusField === e.currentTarget.id) this.setData({ focusField: '' });
  },

  onActionToggle(e) {
    const key = e.currentTarget.dataset.action as string;
    this.setData({ expanded: key === this.data.expanded ? '' : key, focusField: '', error: '', invalidField: '' });
  },

  onActionAdd() {
    const form = this.data.draft?.form;
    if (!form || this.data.saving) return;
    const action = newAction();
    this.replaceForm({ ...form, actions: [...form.actions, action] }, action.key);
  },

  onActionRemove(e) {
    const form = this.data.draft?.form;
    if (!form || this.data.saving) return;
    const key = e.currentTarget.dataset.action as string;
    const actions = form.actions.filter((item) => item.key !== key);
    this.replaceForm({ ...form, actions }, this.data.expanded === key ? actions[0]?.key ?? '' : this.data.expanded);
  },

  onSetChange(e) {
    const form = this.data.draft?.form;
    if (!form || this.data.saving) return;
    const { action, set, operation } = e.currentTarget.dataset;
    const actions = editSets(form.actions, action, (sets) => {
      if (operation === 'add') return [...sets, newSet()];
      if (operation === 'remove') return sets.filter((row) => row.key !== set);
      return sets.flatMap((row) => row.key === set ? [row, copySet(row)] : [row]);
    });
    this.replaceForm({ ...form, actions });
  },

  onUnitChange(e) {
    const form = this.data.draft?.form;
    if (!form || this.data.saving) return;
    const { action, set, field } = e.currentTarget.dataset;
    const index = Number(e.detail.value);
    const actions = editSets(form.actions, action, (sets) => sets.map((row) => {
      if (row.key !== set) return row;
      if (field === 'load_unit' && LOAD_UNITS[index]) return { ...row, load_unit: LOAD_UNITS[index] };
      if (field === 'quantity_unit' && QUANTITY_UNITS[index]) return { ...row, quantity_unit: QUANTITY_UNITS[index] };
      return row;
    }));
    this.replaceForm({ ...form, actions });
  },

  async commitDraft(draft, write) {
    const record = await saveManualStrengthRecord(this.userId, draft.id, write);
    if (!this.editing) {
      try {
        settleStrengthDraft(this.userId, draft.id, write, record.revision);
      } catch {
        // A replay will confirm the same mutation if disk cleanup failed.
      }
    }
    return { ...draft, revision: record.revision, pending: undefined };
  },

  async resolveConflict(draft) {
    const choice = await wx.showModal({
      title: '训练记录已更新',
      content: '可以保留已输入的内容继续编辑。再次保存会覆盖当前记录。',
      confirmText: '继续编辑',
      cancelText: '暂不处理',
    });
    if (!choice.confirm || this.closed || userStore.getState().user?.id !== this.userId) return draft;
    const record = await getManualStrengthRecord(this.userId, draft.id);
    if (this.closed || userStore.getState().user?.id !== this.userId) return draft;
    const updated = { ...draft, revision: record.revision, pending: undefined };
    this.persistDraft(updated);
    return updated;
  },

  async onSave() {
    const original = this.data.draft;
    if (!original || this.data.saving || this.data.saved || userStore.getState().user?.id !== this.userId) return;
    const validation = validateStrengthForm(original.form);
    if ('field' in validation) {
      this.setData({
        expanded: validation.actionKey || this.data.expanded,
        focusField: validation.field,
        invalidField: validation.field,
        error: validation.message,
      }, () => wx.pageScrollTo({ selector: `#${validation.field}`, duration: 180, offsetTop: -24 }));
      return;
    }

    let draft = original;
    this.setData({ saving: true, error: '', invalidField: '' });
    try {
      let saved = false;
      if (draft.pending) {
        // A lost response may follow a committed save. Confirm it before
        // saving any changes made since that snapshot.
        saved = matchesStrengthWrite(draft.form, draft.pending);
        draft = await this.commitDraft(draft, draft.pending);
      }
      if (!saved && !this.closed) {
        const mutationId = await newStrengthId();
        if (this.closed) return;
        if (userStore.getState().user?.id !== this.userId) {
          this.setData({ saving: false, draft: null, loadError: '当前账号已切换，请重新打开训练记录' });
          return;
        }
        const pending: ManualStrengthWrite = {
          ...validation.content,
          mutation_id: mutationId,
          revision: draft.revision,
          ...(this.editing ? {} : { started_at: draft.startedAt }),
        };
        draft = { ...draft, pending };
        this.persistDraft(draft);
        draft = await this.commitDraft(draft, pending);
      }
      if (!this.closed) {
        wx.disableAlertBeforeUnload();
        this.setData({ draft, saving: false, saved: true });
      }
    } catch (err) {
      if (this.closed) return;
      let error = '保存未确认，请重试。已输入的内容会保留。';
      if (err instanceof ApiError && err.statusCode === 409) {
        try {
          const updated = await this.resolveConflict(draft);
          error = updated === draft ? '这条记录已更新，请处理冲突后重试。' : '确认内容后可再次保存。';
          draft = updated;
        } catch {
          error = '暂时无法获取最新记录，请重试。';
        }
      } else if (err instanceof ApiError && err.statusCode === 400) {
        draft = { ...draft, pending: undefined };
        this.persistDraft(draft);
        error = '记录格式有误，请检查训练名称、负重和数量。';
      }
      if (!this.closed) this.setData({ draft, saving: false, error });
    }
  },
});
