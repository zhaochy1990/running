'use strict';

const manualLog = (() => {
  const { escapeHTML: escape } = miniProgramHome;
  const loadUnits = { kg: 'kg', lb: 'lb', bodyweight: '自重' };
  const units = { reps: '个', seconds: '秒' };
  const initialSet = { load: '', loadUnit: 'kg', amount: '0', unit: 'reps' };
  const dates = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const records = [];
  let activeDraft = null;
  let activeRecord = null;
  let activeExerciseId = null;
  let nextId = 1;
  let selected = 0;
  let editing = null;
  let saveFeedbackTimer;
  let app;

  function today(time = new Date()) {
    const parts = Object.fromEntries(dates.formatToParts(time).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function defaultTitle(date) {
    return `${date} 力量训练`;
  }

  function newRow(source) {
    return { ...initialSet, ...source, id: nextId++ };
  }

  function newExercise() {
    return { id: nextId++, name: '', rows: [newRow()] };
  }

  function draft() {
    if (editing) return editing.draft;
    if (!activeDraft) {
      const startedAt = new Date();
      const date = today(startedAt);
      activeDraft = { title: defaultTitle(date), date, startedAt: startedAt.toISOString(), exercises: [newExercise()], note: '' };
    }
    return activeDraft;
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
      if (!hasDraft()) {
        activeDraft = null;
        activeRecord = null;
      }
      app.navigate('schedule');
    }
  }

  function options(values, selectedValue) {
    return Object.entries(values).map(([value, label]) =>
      `<option value="${value}"${value === selectedValue ? ' selected' : ''}>${label}</option>`).join('');
  }

  function logButton(action, label, className, data = '') {
    return `<button type="button" class="${className}" data-log-action="${action}" ${data}>${label}</button>`;
  }

  function rowView(row, index) {
    const number = index + 1;
    return `<div class="log-set" data-log-row="${row.id}" role="group" aria-label="第 ${number} 组">
      <span class="log-set-number" aria-hidden="true">${number}</span>
      <input data-log-field="load" aria-label="负重" value="${row.loadUnit === 'bodyweight' ? '' : escape(row.load)}"${row.loadUnit === 'bodyweight' ? ' disabled' : ''}>
      <span class="log-unit">
        <select data-log-field="loadUnit" aria-label="负重单位">${options(loadUnits, row.loadUnit)}</select>
      </span>
      <div class="log-amount">
        <input data-log-field="amount" aria-label="数量" inputmode="numeric" value="${escape(row.amount)}">
        <span class="log-unit">
          <select data-log-field="unit" aria-label="数量单位">${options(units, row.unit)}</select>
        </span>
      </div>
      <div class="log-set-actions">
        ${logButton('remove-row', app.icon('cross', 16), 'icon-button log-remove', `aria-label="删除第 ${number} 组"`)}
        ${logButton('copy-row', app.asset('copy'), 'icon-button log-copy', `aria-label="复制第 ${number} 组" title="复制到下一组"`)}
      </div>
    </div>`;
  }

  function exerciseView(exercise, index, expanded) {
    const label = `动作 ${index + 1}`;
    const body = expanded ? `
      <div class="log-exercise-head">
        <label class="log-field log-name-field">
          <span>动作名称</span>
          <input data-log-field="name" placeholder="如深蹲" value="${escape(exercise.name)}">
        </label>
        ${logButton('remove-exercise', app.icon('cross', 14), 'icon-button log-remove', `aria-label="删除${label}"`)}
      </div>
      ${exercise.rows.length ? '<div class="log-set log-set-labels" aria-hidden="true"><span>组数</span><span>负重</span><span>单位</span><span>数量</span></div>' : ''}
      ${exercise.rows.map(rowView).join('')}
      <div class="log-exercise-footer">
        ${logButton('add-row', `${app.icon('plus', 16)}添加一组`, 'text-button log-add-row')}
      </div>` : logButton('open-exercise',
        `<span class="log-exercise-name">${escape(exercise.name.trim() || label)}</span>
         <span class="log-exercise-count">${exercise.rows.length} 组</span>${app.icon('right', 15)}`,
        'log-exercise-summary', 'aria-expanded="false"');
    return `<section class="log-exercise${expanded ? '' : ' is-collapsed'}" data-log-exercise="${exercise.id}" aria-label="${label}" tabindex="-1">
      ${body}
    </section>`;
  }

  function expandedExercise(entry) {
    const id = editing ? editing.exerciseId : activeExerciseId;
    return entry.exercises.find(exercise => exercise.id === id) ?? entry.exercises[0];
  }

  function showExercise(id) {
    if (editing) editing.exerciseId = id;
    else activeExerciseId = id;
    app.render();
    return app.screen.querySelector(`[data-log-exercise="${id}"]`);
  }

  function editView() {
    const entry = draft();
    const expanded = expandedExercise(entry);
    return {
      title: editing ? '编辑记录' : '自由力量训练',
      content: `<form id="manual-form" class="manual-form" novalidate>
        <label class="log-field log-name-field"><span>训练名称</span><input data-log-field="title" placeholder="${defaultTitle(entry.date)}" value="${escape(entry.title)}"></label>
        <h3 class="log-section-head">动作明细</h3>
        ${entry.exercises.map((exercise, index) => exerciseView(exercise, index, exercise === expanded)).join('')}
        ${logButton('add-exercise', `${app.icon('plus', 18)}添加动作`, 'secondary log-add-exercise')}
        <div class="log-field log-note-field">
          <textarea aria-label="训练备注" data-log-field="note" rows="4" placeholder="训练备注（选填）">
${escape(entry.note)}</textarea>
        </div>
        <p id="manual-error" class="log-error" role="alert"></p>
      </form>`,
      footer: '<button type="submit" class="primary" form="manual-form">保存记录</button>' +
        '<p class="log-save-status" role="status"></p>',
    };
  }

  function totals(entry) {
    return entry.exercises.reduce((sum, exercise) =>
      sum + exercise.rows.length, 0);
  }

  function recordTitle(record) {
    return record.data.title.trim() || defaultTitle(record.data.date);
  }

  function line(row) {
    const load = row.load.trim();
    const amount = `${Number(row.amount)} ${units[row.unit]}`;
    if (row.loadUnit === 'bodyweight') return `${loadUnits.bodyweight} · ${amount}`;
    return load ? `${load} ${loadUnits[row.loadUnit]} · ${amount}` : amount;
  }

  function activityRows() {
    return records.map(record => ({
      id: record.id,
      title: escape(recordTitle(record)),
      date: record.data.date,
      source: '手动记录',
      details: `${record.data.exercises.length} 个动作 · ${totals(record.data)} 组`,
    }));
  }

  function hasDraft() {
    if (!activeDraft) return false;
    if (activeRecord) return JSON.stringify(activeDraft) !== JSON.stringify(activeRecord.data);
    const title = activeDraft.title.trim();
    const customTitle = title && title !== defaultTitle(activeDraft.date);
    return Boolean(customTitle || activeDraft.note.trim() || activeDraft.exercises.length !== 1 ||
      activeDraft.exercises.some(exercise => exercise.name.trim() || exercise.rows.length !== 1 ||
        exercise.rows.some(row => Object.keys(initialSet).some(key => row[key].trim() !== initialSet[key]))));
  }

  function savedView() {
    const record = records.find(item => item.id === selected);
    const entry = record.data;
    return {
      title: '力量训练记录',
      content: `<div class="log-saved-header">
        <h2 class="page-heading" tabindex="-1">${escape(recordTitle(record))}</h2>
        <p class="eyeline">${entry.date} · 手动记录 · ${entry.exercises.length} 个动作 / ${totals(entry)} 组</p>
      </div>
      ${entry.exercises.map(exercise => `<section class="log-saved-exercise">
        <h3>${escape(exercise.name.trim())}</h3>
        <ol>${exercise.rows.map((row, index) => `<li><span class="log-saved-index">第 ${index + 1} 组</span><span>${escape(line(row))}</span></li>`).join('')}</ol>
      </section>`).join('')}
      ${entry.note.trim() ? `<section class="log-saved-note">
        <h3>训练备注</h3>
        <p class="log-record-note">${escape(entry.note)}</p>
      </section>` : ''}`,
      footer: `<div class="log-saved-actions">
        ${logButton('edit', '编辑记录', 'secondary')}
        ${logButton('coach', '和教练聊一聊', 'primary')}
      </div>`,
    };
  }

  const views = { manualEdit: editView, manualSaved: savedView };

  function view(page) {
    return views[page]();
  }

  function positiveInteger(value) {
    return /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  }

  function validate(entry) {
    if (!entry.exercises.length) return { action: 'add-exercise', message: '请添加至少一个动作。' };

    for (const exercise of entry.exercises) {
      const location = `[data-log-exercise="${exercise.id}"]`;
      if (!exercise.name.trim()) return { location, exerciseId: exercise.id, field: 'name', message: '请填写动作名称。' };
      if (!exercise.rows.length) return { location, exerciseId: exercise.id, action: 'add-row', message: '请记录至少一组。' };
      for (const row of exercise.rows) {
        const location = `[data-log-row="${row.id}"]`;
        if (!positiveInteger(row.amount)) return { location, exerciseId: exercise.id, field: 'amount', message: '请输入大于 0 的整数作为数量。' };
      }
    }
    return null;
  }

  function clearError(field) {
    const annotated = app.screen.querySelector('[aria-describedby="manual-error"]');
    if (field && field !== annotated) return;
    app.screen.querySelector('#manual-error').textContent = '';
    annotated?.removeAttribute('aria-invalid');
    annotated?.removeAttribute('aria-describedby');
  }

  function save() {
    const entry = draft();
    clearError();
    const error = validate(entry);
    if (error) {
      if (error.exerciseId && error.exerciseId !== expandedExercise(entry)?.id) showExercise(error.exerciseId);
      const area = error.location ? app.screen.querySelector(error.location) : app.screen;
      const field = error.field ? area.querySelector(`[data-log-field="${error.field}"]`)
        : area.querySelector(`[data-log-action="${error.action}"]`);
      const feedback = app.screen.querySelector('#manual-error');
      const anchor = field.closest('.log-set, .log-exercise-head, .log-exercise-footer') ?? field.closest('.log-field') ?? field;
      anchor.after(feedback);
      feedback.textContent = error.message;
      field.setAttribute('aria-describedby', 'manual-error');
      if (error.field) field.setAttribute('aria-invalid', 'true');
      field.focus();
      feedback.scrollIntoView({ block: 'nearest' });
      return;
    }

    if (!editing) entry.endedAt = new Date().toISOString();
    const snapshot = structuredClone(entry);
    let record;
    if (editing) {
      record = records.find(item => item.id === selected);
      editing.original = snapshot;
    } else {
      if (!activeRecord) {
        activeRecord = { id: nextId++, data: snapshot };
        records.push(activeRecord);
      }
      record = activeRecord;
    }
    record.data = snapshot;
    app.revealActivity(record.id, snapshot.date);
    const status = app.actions.querySelector('.log-save-status');
    clearTimeout(saveFeedbackTimer);
    status.textContent = '已保存';
    saveFeedbackTimer = setTimeout(() => { status.textContent = ''; }, 1800);
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
    entry[key] = field.value;
    if (key === 'loadUnit') {
      const load = field.closest('[data-log-row]').querySelector('[data-log-field="load"]');
      load.disabled = row.loadUnit === 'bodyweight';
      load.value = load.disabled ? '' : row.load;
    }
    app.actions.querySelector('.log-save-status').textContent = '';
    clearError(field);
  }

  function click(event) {
    const control = event.target.closest('button[data-log-action]');
    if (!control) return;
    const { logAction, record } = control.dataset;
    switch (logAction) {
      case 'coach': app.openCoach(selected); break;
      case 'show': {
        const saved = records.find(item => item.id === Number(record));
        selected = saved.id;
        app.revealActivity(selected, saved.data.date);
        app.navigate('manualSaved');
        break;
      }
      case 'resume-active':
        app.closeSheet();
        open();
        break;
      case 'edit':
      case 'edit-saved-only': {
        const saved = records.find(item => item.id === selected);
        if (saved === activeRecord && hasDraft()) {
          if (logAction === 'edit') {
            app.openSheet('这次训练还有草稿',
              '<p class="sheet-copy">可以继续填写，也可以放弃未保存的内容，编辑已保存的记录。</p>',
              logButton('resume-active', '继续记录', 'primary', 'autofocus') +
              logButton('edit-saved-only', '放弃草稿并编辑', 'secondary'));
            break;
          }
          app.closeSheet();
          activeDraft = null;
          activeRecord = null;
        }
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
        showExercise(exercise.id).querySelector('input').focus();
        break;
      }
      case 'open-exercise': {
        const panel = showExercise(exerciseOf(control).id);
        panel.focus({ preventScroll: true });
        panel.firstElementChild.scrollIntoView({ block: 'nearest' });
        break;
      }
      case 'remove-exercise': {
        const exercise = exerciseOf(control);
        const exercises = draft().exercises;
        const index = exercises.indexOf(exercise);
        exercises.splice(index, 1);
        const next = exercises[Math.min(index, exercises.length - 1)];
        const panel = showExercise(next?.id);
        (panel ?? app.screen.querySelector('[data-log-action="add-exercise"]')).focus();
        break;
      }
      case 'add-row':
      case 'copy-row': {
        const exercise = exerciseOf(control);
        const source = rowOf(control, exercise);
        const row = newRow(source);
        if (source) exercise.rows.splice(exercise.rows.indexOf(source) + 1, 0, row);
        else exercise.rows.push(row);
        app.render();
        const rendered = app.screen.querySelector(`[data-log-row="${row.id}"]`);
        rendered.querySelector(source ? '[data-log-action="copy-row"]' : '[data-log-field="amount"]').focus();
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

  function selectInitialAmount(event) {
    const field = event.target;
    if (field.matches('[data-log-field="amount"]') && field.value === initialSet.amount) field.select();
  }

  function setup(dependencies) {
    app = dependencies;
    document.addEventListener('click', click);
    app.screen.addEventListener('focusin', selectInitialAmount);
    app.screen.addEventListener('click', selectInitialAmount);
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

  function coachRecords() {
    return records.map(record => ({
      id: record.id,
      title: recordTitle(record),
      date: record.data.date,
      endedAt: record.data.endedAt,
      note: record.data.note,
      exercises: record.data.exercises.map(exercise => ({
        name: exercise.name.trim(),
        sets: exercise.rows.map(line),
      })),
    }));
  }

  return { setup, isPage, view, open, back, activityRows, hasDraft, coachRecords, today };
})();
