'use strict';

const art = '../../../strength_illustrations/output/';
const plan = [
  { name: '徒手深蹲', focus: '股四头肌 · 臀大肌', target: 12, unit: '次', rest: 45, image: 'T1061/v1.png', cue: '臀部向后下坐，脚掌充分着地，膝盖朝脚尖方向。' },
  { name: '仰卧臀桥', focus: '臀大肌 · 腘绳肌', target: 12, unit: '次', rest: 45, image: 'T1132/v1.png', cue: '用脚跟向下发力，抬髋到肩、髋、膝大致成一线。' },
  { name: '站立提踵', focus: '小腿后侧', target: 15, unit: '次', rest: 30, image: 'T1070/v3.png', cue: '抬起脚跟，在最高点稍作停顿，再缓慢落下。' },
  { name: '平板支撑', focus: '核心稳定', target: 40, unit: '秒', rest: 30, image: 'T1010/v1.png', cue: '肘部放在肩下，头、髋和脚跟大致成一线。' },
];
const setsPerExercise = 3;
const totalSets = plan.length * setsPerExercise;
const lesson = '跑者下肢力量';
const params = new URLSearchParams(location.search);
const entryViews = { manual: 'manualEdit', plan: 'plan', records: 'records', coach: 'coach' };
const entryView = params.get('view');
let page = Object.hasOwn(entryViews, entryView) ? entryViews[entryView] : 'schedule';
let session = null;
let saved = null;
let renderedPage = '';
let renderedStage = '';
let pendingActivity = null;
let sheetReturnFocus;

const device = document.querySelector('.device');
const screen = document.querySelector('#screen');
const tabBar = document.querySelector('#mp-tabs');
const actions = document.querySelector('#actions');
const sheet = document.querySelector('#sheet');
const appTitle = document.querySelector('#app-title');
appTitle.tabIndex = -1;
const appSubtitle = document.querySelector('#app-subtitle');
const back = document.querySelector('.app-back');

const symbols = {
  left: '<path d="m14 6-6 6 6 6"/>',
  right: '<path d="m10 6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  cross: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6M18 5l2-2"/>',
  lift: '<path d="M6 6v12M3 9v6M21 9v6M18 6v12M6 12h12"/>',
};
function icon(name, size = 20) {
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${symbols[name]}</svg>`;
}

function picture(exercise, className, alt = '') {
  return `<img class="${className}" src="${art}${exercise.image}" alt="${alt}" draggable="false">`;
}

function primary(action, label, mark = '') {
  return `<button type="button" class="primary" data-action="${action}">${mark}${label}</button>`;
}

function clock(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

function remainingRest() {
  return Math.max(0, Math.ceil((session.rest.ends - Date.now()) / 1000));
}

function startTraining() {
  if (!session) {
    session = {
      started: Date.now(),
      records: Array(totalSets).fill(null),
      drafts: new Map(),
      order: [],
      rest: null,
    };
  }
  page = 'active';
}

function firstMissing() {
  return session.records.indexOf(null);
}

function contextFor(index) {
  const exerciseId = Math.floor(index / setsPerExercise);
  return { exerciseId, exercise: plan[exerciseId], group: index % setsPerExercise + 1 };
}

function target(exercise) {
  return `${exercise.target} ${exercise.unit}`;
}

function exerciseRow(exercise, exerciseId) {
  return `<button type="button" class="exercise-button" data-action="details" data-id="${exerciseId}" aria-haspopup="dialog">
    ${picture(exercise, 'thumb')}
    <span><span class="exercise-name">${exercise.name}</span><span class="exercise-subtitle">组间休息 ${exercise.rest} 秒</span></span>
    <span class="exercise-target">${setsPerExercise} 组 × ${target(exercise)}</span>${icon('right', 15)}
  </button>`;
}

function planView() {
  return {
    title: '课表详情',
    content: `<article class="plan-hero">
      <div>
        <h2 tabindex="-1">${lesson}</h2>
        <p>11 月 25 日 · 周三 · 教练课表</p>
        <div class="plan-meta">${icon('lift', 15)} <span>力量训练 · 约 25 分钟</span></div>
      </div>
      ${picture(plan[0], 'hero-art')}
    </article>
    <div class="section-heading"><h3>动作清单</h3><span>${plan.length} 个动作 · ${totalSets} 组</span></div>
    <ul class="exercise-list">${plan.map((exercise, id) => `<li>${exerciseRow(exercise, id)}</li>`).join('')}</ul>`,
    footer: primary('start', session ? '继续训练' : saved ? '再次训练' : '开始训练', icon('lift', 19)) +
      (saved && !session ? '<button type="button" class="secondary" data-action="summary">查看训练小结</button>' : ''),
  };
}

function progress() {
  const done = session.order.length;
  return `<div class="progress">
    <div class="progress-text"><strong class="number">${done}/${totalSets}</strong> 组 · <time data-elapsed>${clock((Date.now() - session.started) / 1000)}</time></div>
    <button type="button" class="text-button" data-action="finish" aria-haspopup="dialog">结束训练</button>
  </div>
  <div class="progress-track" aria-hidden="true">${session.records.map(value => `<span${value === null ? '' : ' class="logged"'}></span>`).join('')}</div>`;
}

function inputFor(index, exercise, label) {
  return `<input id="actual-guide" type="text" inputmode="numeric" autocomplete="off" aria-label="${label}" aria-describedby="input-message-${index}" data-value="${index}" value="${exercise.target}">`;
}

function guided(index) {
  const { exerciseId, exercise, group } = contextFor(index);
  return `<div class="guide-visual">${picture(exercise, 'guide-art', `${exercise.name}肌肉示意图`)}</div>
    <div class="guide-title"><h2 tabindex="-1">${exercise.name}</h2>
      <button type="button" class="text-button" data-action="details" data-id="${exerciseId}" aria-haspopup="dialog">动作要点</button></div>
    <p class="guide-details">动作 ${exerciseId + 1}/${plan.length} · 第 ${group}/${setsPerExercise} 组 · 休息 ${exercise.rest} 秒</p>
    <div class="counter-block">
      <label class="counter-label" for="actual-guide">实际完成 <small>课表目标 ${target(exercise)}</small></label>
      <div class="counter">
        <button type="button" class="icon-button" data-action="adjust" data-step="-1" data-index="${index}" aria-label="减少 ${exercise.unit}">${icon('minus')}</button>
        <div class="counter-value">${inputFor(index, exercise, `实际完成${exercise.unit === '次' ? '次数' : '时长（秒）'}`)}<span>${exercise.unit}</span></div>
        <button type="button" class="icon-button" data-action="adjust" data-step="1" data-index="${index}" aria-label="增加 ${exercise.unit}">${icon('plus')}</button>
      </div>
      <p class="input-message" id="input-message-${index}" role="status"></p>
    </div>
    ${session.order.length ? '<button type="button" class="text-button" data-action="undo">撤回上一组</button>' : ''}`;
}

function restFocus(index) {
  const { exercise, group } = contextFor(index);
  return `<div class="rest-focus">
    ${icon('timer', 34)}
    <h2 tabindex="-1">组间休息</h2>
    <time aria-label="休息剩余时间" data-rest>${clock(remainingRest())}</time>
    <div class="rest-rail" aria-hidden="true"><span data-rail></span></div>
    <div class="next-exercise">${picture(exercise, 'thumb')}<div><p class="eyeline">接下来 · 第 ${group} 组</p><strong>${exercise.name} · ${target(exercise)}</strong></div></div>
    <button type="button" class="text-button" data-action="undo">撤回上一组</button>
  </div>`;
}

function activeView() {
  const next = firstMissing();
  let content;
  let footer = '';
  if (next === -1) {
    content = `<div class="summary-intro">${icon('check', 26)}<h2 class="page-heading" tabindex="-1">全部完成</h2><p>已记录 ${totalSets} 组</p></div><button type="button" class="text-button" data-action="undo">撤回上一组</button>`;
    footer = primary('finish', '查看训练小结');
  } else if (session.rest) {
    content = restFocus(next);
    footer = primary('skip', '跳过休息');
  } else {
    content = guided(next);
    footer = `<button type="button" class="primary" data-action="record" data-index="${next}">${icon('check', 19)}完成第 ${contextFor(next).group} 组</button>`;
  }
  return { title: '训练中', content: progress() + content, footer };
}

function summaryView() {
  const done = saved.records.filter(value => value !== null).length;
  const isComplete = done === totalSets;
  const exerciseCount = plan.filter((exercise, i) => saved.records.slice(i * setsPerExercise, (i + 1) * setsPerExercise).some(value => value !== null)).length;
  return {
    title: '训练小结',
    content: `<div class="summary-intro">
      ${icon('check', 29)}
      <h2 class="page-heading" tabindex="-1">${isComplete ? '训练完成' : '本次训练已记录'}</h2><p>${lesson}</p>
    </div>
    <div class="summary-stats">
      <div><strong class="number">${done}/${totalSets}</strong><span>完成组数</span></div>
      <div><strong class="number">${exerciseCount}/${plan.length}</strong><span>已练动作</span></div>
      <div><strong class="number">${clock(saved.elapsed)}</strong><span>用时</span></div>
    </div>
    <div class="section-heading"><h3>各组实际完成量</h3></div>
    <ul class="summary-list">${plan.map((exercise, id) => {
      const values = saved.records.slice(id * setsPerExercise, (id + 1) * setsPerExercise);
      return `<li><div><span class="exercise-name">${exercise.name}</span><small>${values.map(value => value === null ? '未记录' : `${value} ${exercise.unit}`).join(' · ')}</small></div>
        <strong class="number">${values.filter(value => value !== null).length}/${setsPerExercise} 组</strong></li>`;
    }).join('')}</ul>`,
    footer: primary('plan', '返回课表'),
  };
}

const views = {
  schedule: () => miniProgramHome.training(lesson, plan.length, totalSets, manualLog.hasDraft()),
  records: () => miniProgramHome.records(manualLog.activityRows(), params.get('state') === 'empty'),
  coach: coachPreview.view,
  plan: planView,
  active: activeView,
  summary: summaryView,
};

function render() {
  const view = manualLog.isPage(page) ? manualLog.view(page) : views[page]();
  const stage = page === 'active' && session.rest ? 'rest' : page;
  const scroll = renderedPage === page && renderedStage === stage ? screen.scrollTop : 0;
  const focus = document.activeElement;
  const oldControl = focus?.matches('button[data-action]') && (screen.contains(focus) || actions.contains(focus));
  appTitle.textContent = view.title;
  appSubtitle.textContent = view.subtitle ?? '';
  appSubtitle.hidden = !view.subtitle;
  back.hidden = Boolean(view.tab);
  device.classList.toggle('has-mp-tabs', Boolean(view.tab));
  tabBar.hidden = !view.tab;
  tabBar.innerHTML = view.tab ? miniProgramHome.tabBar(view.tab) : '';
  screen.classList.toggle('mp-home', Boolean(view.tab));
  screen.innerHTML = view.content;
  const guideInput = screen.querySelector('#actual-guide');
  if (guideInput) guideInput.value = session.drafts.get(Number(guideInput.dataset.value)) ?? guideInput.value;
  actions.innerHTML = view.footer;
  screen.scrollTop = scroll;

  if (oldControl && renderedPage === page) {
    const replacement = [...device.querySelectorAll('button[data-action]')].find(button =>
      ['action', 'index', 'id', 'step'].every(key => button.dataset[key] === focus.dataset[key]));
    (replacement || screen.querySelector('h2') || actions.firstElementChild)?.focus({ preventScroll: true });
  }
  for (const list of document.querySelectorAll('.journey ol')) {
    const steps = [...list.querySelectorAll('[data-stage]')];
    list.hidden = !steps.some(step => step.dataset.stage === stage);
    steps.forEach(step => {
      if (step.dataset.stage === stage) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
  }
  renderedPage = page;
  renderedStage = stage;
  updateClocks();
}

function endRest() {
  session.rest = null;
  if (page === 'active') render();
}

function updateClocks() {
  if (!session) return;
  const elapsed = screen.querySelector('[data-elapsed]');
  if (elapsed) elapsed.textContent = clock((Date.now() - session.started) / 1000);
  const rest = device.querySelector('[data-rest]');
  if (rest && session.rest) rest.textContent = clock(remainingRest());
  const rail = screen.querySelector('[data-rail]');
  if (rail && session.rest) rail.style.width = `${remainingRest() / session.rest.seconds * 100}%`;
}

function showInputError(input, message = '') {
  const note = document.getElementById(input.getAttribute('aria-describedby'));
  note.textContent = message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function actualValue(value) {
  const text = value.trim();
  return /^[0-9]{1,3}$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

function changeValue(index, step) {
  const { exercise } = contextFor(index);
  const input = screen.querySelector(`[data-value="${index}"]`);
  const current = actualValue(input.value) ?? exercise.target;
  const updated = String(Math.min(999, Math.max(1, current + step)));
  input.value = updated;
  showInputError(input);
  session.drafts.set(index, updated);
}

function record(index) {
  const input = screen.querySelector(`[data-value="${index}"]`);
  const actual = actualValue(input.value);
  if (actual === null) {
    showInputError(input, '请输入 1–999 的整数。');
    input.focus();
    return;
  }
  const { exercise } = contextFor(index);
  session.records[index] = actual;
  session.order.push(index);
  if (firstMissing() >= 0) {
    session.rest = { ends: Date.now() + exercise.rest * 1000, seconds: exercise.rest, index };
  } else {
    session.rest = null;
  }
  render();
}

function withdraw(index) {
  session.drafts.set(index, String(session.records[index]));
  session.records[index] = null;
  session.order = session.order.filter(recorded => recorded !== index);
  if (session.rest?.index === index) session.rest = null;
  render();
  screen.querySelector(`[data-value="${index}"]`)?.focus();
}

function positionSheet() {
  const frame = device.getBoundingClientRect();
  sheet.style.position = 'fixed';
  sheet.style.left = `${frame.left + device.clientLeft}px`;
  sheet.style.right = 'auto';
  sheet.style.bottom = `${Math.max(0, innerHeight - frame.top - device.clientTop - device.clientHeight)}px`;
  sheet.style.width = `${device.clientWidth}px`;
  sheet.style.maxHeight = `${Math.min(device.clientHeight, innerHeight) - 8}px`;
}

function openSheet(title, body, buttons = '') {
  sheetReturnFocus = document.activeElement;
  sheet.innerHTML = `<div class="sheet-handle" aria-hidden="true"></div>
    <div class="sheet-head"><h2 id="sheet-title">${title}</h2>
    <button type="button" class="icon-button" data-action="close" aria-label="关闭">${icon('cross')}</button></div>
    ${body}<div class="sheet-actions">${buttons}</div>`;
  positionSheet();
  sheet.showModal();
}

function showDetails(id) {
  const exercise = plan[id];
  openSheet(exercise.name,
    `${picture(exercise, 'sheet-art', `${exercise.name}肌肉示意图`)}
      <p class="sheet-copy">${exercise.focus} · ${setsPerExercise} 组 × ${target(exercise)} · 休息 ${exercise.rest} 秒</p>
      <p class="sheet-copy">${exercise.cue}</p>`);
}

function finish() {
  if (session.order.length === totalSets) {
    save();
    return;
  }
  const done = session.order.length;
  const copy = done
    ? `已记录 ${done}/${totalSets} 组。现在结束会保留已记录的组。`
    : '还没有记录任何组。结束后会返回课表。';
  openSheet('结束本次训练？', `<p class="sheet-copy">${copy}</p>`,
    primary(done ? 'save' : 'discard', done ? '结束并保存' : '结束训练') +
    '<button type="button" class="secondary" data-action="close" autofocus>继续训练</button>');
}

function save() {
  sheet.close();
  saved = { records: [...session.records], elapsed: (Date.now() - session.started) / 1000 };
  session = null;
  page = 'summary';
  render();
  screen.querySelector('h2')?.focus({ preventScroll: true });
}

function revealActivity(id, date) {
  miniProgramHome.revealMonth(date);
  pendingActivity = id;
}

function openCoach(recordId) {
  const changed = coachPreview.open(recordId);
  if (page !== 'coach') {
    navigate('coach');
  } else if (changed) {
    render();
    tabBar.querySelector('[aria-current="page"]').focus({ preventScroll: true });
  }
  screen.scrollTop = screen.scrollHeight;
}

function navigate(next) {
  if (page === next) return;
  page = next;
  render();
  if (page === 'records' && pendingActivity !== null) {
    const activity = screen.querySelector(`[data-record="${pendingActivity}"]`);
    pendingActivity = null;
    if (activity) {
      activity.focus();
      return;
    }
  }
  const heading = screen.querySelector('h2[tabindex]') || appTitle;
  heading.focus({ preventScroll: true });
}

document.addEventListener('click', event => {
  const control = event.target.closest('button[data-action]');
  if (!control) return;
  const { action, index, step, id } = control.dataset;
  switch (action) {
    case 'coach': openCoach(); break;
    case 'schedule': navigate('schedule'); break;
    case 'records': navigate('records'); break;
    case 'select-day': miniProgramHome.selectDay(Number(id)); render(); break;
    case 'toggle-month': miniProgramHome.toggleMonth(id); render(); break;
    case 'back':
      if (manualLog.isPage(page)) manualLog.back(page);
      else navigate(page === 'plan' ? 'schedule' : 'plan');
      break;
    case 'manual': manualLog.open(); break;
    case 'plan': navigate('plan'); break;
    case 'summary': navigate('summary'); break;
    case 'start':
      startTraining();
      render();
      screen.querySelector('h2')?.focus({ preventScroll: true });
      break;
    case 'details': showDetails(Number(id)); break;
    case 'close': sheet.close(); break;
    case 'adjust': changeValue(Number(index), Number(step)); break;
    case 'record': record(Number(index)); break;
    case 'undo': withdraw(session.order.at(-1)); break;
    case 'skip': endRest(); break;
    case 'finish': finish(); break;
    case 'save': save(); break;
    case 'discard':
      sheet.close();
      session = null;
      navigate('plan');
      break;
  }
});

actions.addEventListener('submit', event => {
  if (event.target.id !== 'coach-preview-form') return;
  event.preventDefault();
  const message = new FormData(event.target).get('message').trim();
  if (!message) return;
  const exchange = coachPreview.send(message, params.get('state') !== 'empty');
  screen.querySelector('.coach-messages').insertAdjacentHTML('beforeend', exchange);
  event.target.reset();
  screen.scrollTop = screen.scrollHeight;
  event.target.elements.message.focus();
});

screen.addEventListener('input', event => {
  const input = event.target.closest('input[data-value]');
  if (!input) return;
  showInputError(input);
  session.drafts.set(Number(input.dataset.value), input.value);
});

sheet.addEventListener('close', () => {
  if (sheetReturnFocus?.isConnected) sheetReturnFocus.focus({ preventScroll: true });
});
window.addEventListener('resize', () => {
  if (sheet.open) positionSheet();
});

setInterval(() => {
  if (session?.rest && !remainingRest() && !sheet.open) endRest();
  updateClocks();
}, 250);

back.innerHTML = icon('left', 23);
manualLog.setup({
  screen, actions, render, navigate, icon, asset: miniProgramHome.asset, openSheet, revealActivity, openCoach,
  closeSheet: () => {
    sheetReturnFocus = null;
    sheet.close();
  },
});
render();
