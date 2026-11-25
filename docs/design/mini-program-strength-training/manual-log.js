'use strict';

const manualLog = (() => {
  const loads = { none: '未填重量', kg: 'kg', bar: '空杠', body: '自重' };
  const units = { reps: '次', seconds: '秒' };
  const modeLabels = { structured: '按动作', note: '随手记' };
  const dates = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const records = [];
  const drafts = {};
  let nextId = 1;
  let mode = 'structured';
  let selected = 0;
  let editing = null;
  let app;

  function today() {
    const parts = Object.fromEntries(dates.formatToParts().map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function newRow(load = 'none', weight = '', amount = '', sets = '1', unit = 'reps') {
    return { id: nextId++, load, weight, amount, sets, unit };
  }

  function newExercise(name = '', rows = [newRow()], note = '') {
    return { id: nextId++, name, rows, note };
  }

  function newDraft(kind) {
    const common = { title: '', date: today() };
    return kind === 'structured' ? { ...common, exercises: [newExercise()] } : { ...common, note: '' };
  }

  function draft() {
    if (editing) return editing.draft;
    return (drafts[mode] ??= newDraft(mode));
  }

  function isPage(page) {
    return Object.hasOwn(views, page);
  }

  function open() {
    editing = null;
    app.navigate('manualEdit');
  }

  function back(page) {
    if (page === 'manualSaved') {
      app.navigate('records');
    } else if (editing) {
      if (JSON.stringify(editing.draft) === JSON.stringify(editing.original)) {
        editing = null;
        app.navigate('manualSaved');
      } else {
        app.openSheet('放弃本次修改？', '<p class="sheet-copy">已保存的训练记录会保留。</p>',
          '<button type="button" class="primary" data-action="close" autofocus>继续编辑</button>' +
          logButton('discard-edit', '放弃修改', 'secondary'));
      }
    } else {
      app.navigate('schedule');
    }
  }

  function escape(value) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value).replace(/[&<>"']/g, char => entities[char]);
  }

  function options(values, selectedValue) {
    return Object.entries(values).map(([value, label]) =>
      `<option value="${value}"${value === selectedValue ? ' selected' : ''}>${label}</option>`).join('');
  }

  function logButton(action, label, className, data = '') {
    return `<button type="button" class="${className}" data-log-action="${action}" ${data}>${label}</button>`;
  }

  function rowView(row, index) {
    return `<div class="log-set" data-log-row="${row.id}" role="group" aria-label="第 ${index + 1} 条组记录">
      <div class="log-load">
        <select data-log-field="load" aria-label="负重方式">${options(loads, row.load)}</select>
        ${row.load === 'kg' ? `<input data-log-field="weight" aria-label="重量（kg）" inputmode="decimal" placeholder="kg" value="${escape(row.weight)}">` : ''}
      </div>
      <div class="log-amount">
        <input data-log-field="amount" aria-label="每组次数或时长" inputmode="numeric" placeholder="—" value="${escape(row.amount)}">
        <select data-log-field="unit" aria-label="计量单位">${options(units, row.unit)}</select>
      </div>
      <div class="log-sets">
        <input data-log-field="sets" aria-label="组数" inputmode="numeric" value="${escape(row.sets)}"><span>组</span>
      </div>
      ${logButton('remove-row', app.icon('cross', 16), 'icon-button log-remove', `aria-label="删除第 ${index + 1} 条组记录"`)}
    </div>`;
  }

  function exerciseView(exercise, index) {
    return `<section class="log-exercise" data-log-exercise="${exercise.id}" aria-label="动作 ${index + 1}">
      <div class="log-exercise-head">
        <input data-log-field="name" aria-label="动作 ${index + 1} 名称" placeholder="动作名称，如深蹲" value="${escape(exercise.name)}">
        ${logButton('remove-exercise', app.icon('cross', 18), 'icon-button log-remove', `aria-label="删除动作 ${index + 1}"`)}
      </div>
      ${exercise.rows.length ? '<div class="log-set log-set-labels" aria-hidden="true"><span>负重</span><span>每组</span><span>组数</span></div>' : ''}
      ${exercise.rows.map(rowView).join('')}
      <div class="log-exercise-footer">
        ${logButton('add-row', `${app.icon('plus', 16)}记一行`, 'text-button log-add-row')}
        <div class="log-field">
          <textarea aria-label="动作 ${index + 1} 备注" data-log-field="exercise-note" rows="1" placeholder="动作备注（选填）">
${escape(exercise.note)}</textarea>
        </div>
      </div>
    </section>`;
  }

  function hasContent(entry, kind) {
    if (kind === 'note') return Boolean(entry.note.trim());
    return entry.exercises.some(exercise => exercise.name.trim() || exercise.note.trim() ||
      exercise.rows.some(row => row.load !== 'none' || row.amount || row.sets !== '1' || row.unit !== 'reps'));
  }

  function editView() {
    const entry = draft();
    const exampleButton = editing ? ''
      : logButton('example', '填入示例', 'text-button', hasContent(entry, mode) ? 'hidden' : '');
    return {
      title: editing ? '编辑记录' : '自由力量训练',
      content: `<div class="log-heading">
        <h2 class="page-heading" tabindex="-1">${editing ? '编辑力量训练' : '记录力量训练'}</h2>
      </div>
      ${editing ? '' : `<div class="log-modes" role="group" aria-label="录入方式">
        ${Object.entries(modeLabels).map(([key, label]) =>
          logButton('mode', label, '', `data-mode="${key}" aria-pressed="${mode === key}"`)).join('')}
      </div>`}
      <form id="manual-form" class="manual-form" novalidate>
        <div class="log-meta">
          <label class="log-field"><span>训练名称</span><input data-log-field="title" placeholder="力量训练" value="${escape(entry.title)}"></label>
          <label class="log-field"><span>训练日期</span><input class="log-date" data-log-field="date" type="date" max="${today()}" value="${escape(entry.date)}"></label>
        </div>
        <div class="log-section-head"><h3>${mode === 'structured' ? '动作明细' : '训练笔记'}</h3>${exampleButton}</div>
        ${mode === 'structured'
          ? `${entry.exercises.map(exerciseView).join('')}
            ${logButton('add-exercise', `${app.icon('plus', 18)}添加动作`, 'secondary log-add-exercise')}`
          : `<div class="log-field"><textarea class="log-notebook" aria-label="训练笔记" data-log-field="note" rows="12" placeholder="可以写下动作、各组重量和次数，或今天的训练感受。">
${escape(entry.note)}</textarea></div>`}
        <p id="manual-error" class="log-error" role="alert"></p>
      </form>`,
      footer: '<button type="submit" class="primary" form="manual-form">保存记录</button>',
    };
  }

  function totals(entry) {
    return entry.exercises.reduce((sum, exercise) =>
      sum + exercise.rows.reduce((count, row) => count + Number(row.sets), 0), 0);
  }

  function recordTitle(record) {
    return escape(record.data.title.trim() || '力量训练');
  }

  function line(row) {
    const load = row.load === 'kg' ? `${Number(row.weight)} kg` : loads[row.load];
    return `${row.load === 'none' ? '' : `${load} · `}${Number(row.amount)} ${units[row.unit]} × ${Number(row.sets)} 组`;
  }

  function activityRows() {
    return records.map(record => ({
      id: record.id,
      title: recordTitle(record),
      date: record.data.date,
      details: record.mode === 'structured' ? `${record.data.exercises.length} 个动作 · ${totals(record.data)} 组` : '训练笔记',
    }));
  }

  function hasDraft() {
    return Object.entries(drafts).some(([kind, entry]) => entry.title.trim() || hasContent(entry, kind));
  }

  function savedView() {
    const record = records.find(item => item.id === selected);
    const entry = record.data;
    const structured = record.mode === 'structured';
    return {
      title: '力量训练记录',
      content: `<div class="log-saved-header">
        <h2 class="page-heading" tabindex="-1">${recordTitle(record)}</h2>
        <p class="eyeline">${entry.date} · 手动记录${structured ? ` · ${entry.exercises.length} 个动作 / ${totals(entry)} 组` : ''}</p>
      </div>
      ${structured
        ? entry.exercises.map(exercise => `<section class="log-saved-exercise">
            <h3>${escape(exercise.name.trim())}</h3>
            <ul>${exercise.rows.map(row => `<li>${line(row)}</li>`).join('')}</ul>
            ${exercise.note.trim() ? `<p class="log-record-note">${escape(exercise.note)}</p>` : ''}
          </section>`).join('')
        : `<div class="log-saved-note">${escape(entry.note)}</div>`}`,
      footer: logButton('records', '返回活动记录', 'secondary') + logButton('edit', '编辑记录', 'primary'),
    };
  }

  const views = { manualEdit: editView, manualSaved: savedView };

  function view(page) {
    return views[page]();
  }

  function fillExample() {
    const entry = draft();
    if (hasContent(entry, mode)) return;
    if (mode === 'note') {
      entry.note = '深蹲\n空杠 15 次\n40 kg 12 次\n50 kg 10 次 × 3 组\n最后一组腿后侧发力感明显。\n\n坐姿提踵\n35 kg 15 次 × 4 组\n\n平板支撑\n40 秒 × 3 组';
    } else {
      entry.exercises = [
        newExercise('深蹲', [newRow('bar', '', '15'), newRow('kg', '40', '12'), newRow('kg', '50', '10', '3')], '最后一组腿后侧发力感明显。'),
        newExercise('坐姿提踵', [newRow('kg', '35', '15', '4')]),
        newExercise('平板支撑', [newRow('body', '', '40', '3', 'seconds')]),
      ];
    }
    app.render();
    app.screen.querySelector('[data-log-field="name"], [data-log-field="note"]')?.focus({ preventScroll: true });
  }

  function positiveInteger(value) {
    return /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  }

  function positiveWeight(value) {
    return /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim()) && Number.isFinite(Number(value)) && Number(value) > 0;
  }

  function validate(entry) {
    if (!entry.date) return { field: 'date', message: '请选择训练日期。' };
    const limit = today();
    if (entry.date.length > limit.length || entry.date > limit) {
      return { field: 'date', message: '请选择今天或更早的训练日期。' };
    }
    if (mode === 'note') return entry.note.trim() ? null : { field: 'note', message: '请写下这次训练的内容。' };
    if (!entry.exercises.length) return { action: 'add-exercise', message: '请添加至少一个动作。' };

    for (const exercise of entry.exercises) {
      const location = `[data-log-exercise="${exercise.id}"]`;
      if (!exercise.name.trim()) return { location, field: 'name', message: '请填写动作名称。' };
      if (!exercise.rows.length) return { location, action: 'add-row', message: '请记录至少一组。' };
      for (const row of exercise.rows) {
        const location = `[data-log-row="${row.id}"]`;
        if (row.load === 'kg' && !positiveWeight(row.weight)) return { location, field: 'weight', message: '请输入大于 0 的重量，例如 12.5。' };
        if (!positiveInteger(row.amount)) return { location, field: 'amount', message: '请输入大于 0 的整数作为次数或秒数。' };
        if (!positiveInteger(row.sets)) return { location, field: 'sets', message: '请输入大于 0 的整数作为组数。' };
      }
    }
    return null;
  }

  function clearError() {
    app.screen.querySelector('#manual-error').textContent = '';
    const annotated = app.screen.querySelector('[aria-describedby="manual-error"]');
    annotated?.removeAttribute('aria-invalid');
    annotated?.removeAttribute('aria-describedby');
  }

  function save() {
    const entry = draft();
    clearError();
    const error = validate(entry);
    if (error) {
      const area = error.location ? app.screen.querySelector(error.location) : app.screen;
      const field = error.field ? area.querySelector(`[data-log-field="${error.field}"]`)
        : area.querySelector(`[data-log-action="${error.action}"]`);
      const feedback = app.screen.querySelector('#manual-error');
      const anchor = field.closest('.log-set, .log-meta, .log-exercise-head, .log-exercise-footer, .log-field') ?? field;
      anchor.after(feedback);
      feedback.textContent = error.message;
      field.setAttribute('aria-describedby', 'manual-error');
      if (error.field) field.setAttribute('aria-invalid', 'true');
      field.focus();
      feedback.scrollIntoView({ block: 'nearest' });
      return;
    }

    if (editing) {
      records.find(record => record.id === selected).data = entry;
      editing = null;
    } else {
      selected = nextId++;
      records.push({ id: selected, mode, data: entry });
      delete drafts[mode];
    }
    app.revealActivity(selected, entry.date);
    app.navigate('manualSaved');
  }

  function exerciseOf(control) {
    const container = control.closest('[data-log-exercise]');
    return container && draft().exercises.find(exercise => exercise.id === Number(container.dataset.logExercise));
  }

  function rowOf(control, exercise) {
    const container = control.closest('[data-log-row]');
    return container && exercise.rows.find(row => row.id === Number(container.dataset.logRow));
  }

  function updateField(event) {
    const field = event.target.closest('[data-log-field]');
    if (!field) return;
    const key = field.dataset.logField;
    const exercise = exerciseOf(field);
    const row = rowOf(field, exercise);
    const entry = row || exercise || draft();
    entry[key === 'exercise-note' ? 'note' : key] = field.value;
    clearError();

    const example = app.screen.querySelector('[data-log-action="example"]');
    if (example) example.hidden = hasContent(draft(), mode);
    if (key === 'load') {
      app.render();
      const rendered = app.screen.querySelector(`[data-log-row="${row.id}"]`);
      rendered.querySelector(row.load === 'kg' ? '[data-log-field="weight"]' : '[data-log-field="load"]').focus();
    }
  }

  function click(event) {
    const control = event.target.closest('button[data-log-action]');
    if (!control) return;
    const { logAction, mode: nextMode, record } = control.dataset;
    switch (logAction) {
      case 'mode':
        mode = nextMode;
        app.render();
        app.screen.scrollTop = 0;
        app.screen.querySelector(`[data-mode="${mode}"]`)?.focus({ preventScroll: true });
        break;
      case 'example': fillExample(); break;
      case 'records': app.navigate('records'); break;
      case 'show': {
        const saved = records.find(item => item.id === Number(record));
        selected = saved.id;
        app.revealActivity(selected, saved.data.date);
        app.navigate('manualSaved');
        break;
      }
      case 'edit': {
        const saved = records.find(item => item.id === selected);
        mode = saved.mode;
        editing = { original: saved.data, draft: structuredClone(saved.data) };
        app.navigate('manualEdit');
        break;
      }
      case 'discard-edit':
        app.closeSheet();
        editing = null;
        app.navigate('manualSaved');
        break;
      case 'add-exercise': {
        const exercise = newExercise();
        draft().exercises.push(exercise);
        app.render();
        app.screen.querySelector(`[data-log-exercise="${exercise.id}"] input`).focus();
        break;
      }
      case 'remove-exercise': {
        const exercise = exerciseOf(control);
        draft().exercises = draft().exercises.filter(item => item !== exercise);
        app.render();
        app.screen.querySelector('[data-log-action="add-exercise"]').focus();
        break;
      }
      case 'add-row': {
        const exercise = exerciseOf(control);
        const row = newRow();
        exercise.rows.push(row);
        app.render();
        app.screen.querySelector(`[data-log-row="${row.id}"] [data-log-field="amount"]`).focus();
        break;
      }
      case 'remove-row': {
        const exercise = exerciseOf(control);
        const row = rowOf(control, exercise);
        exercise.rows = exercise.rows.filter(item => item !== row);
        app.render();
        app.screen.querySelector(`[data-log-exercise="${exercise.id}"] [data-log-action="add-row"]`).focus();
        break;
      }
    }
  }

  function setup(dependencies) {
    app = dependencies;
    document.addEventListener('click', click);
    app.screen.addEventListener('input', event => {
      if (!event.target.matches('select')) updateField(event);
    });
    app.screen.addEventListener('change', event => {
      if (event.target.matches('select')) updateField(event);
    });
    app.screen.addEventListener('submit', event => {
      if (event.target.id !== 'manual-form') return;
      event.preventDefault();
      save();
    });
  }

  return { setup, isPage, view, open, back, activityRows, hasDraft };
})();
