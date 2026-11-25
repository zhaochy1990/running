'use strict';

const miniProgramHome = (() => {
  const icons = '../../../src/wechat-miniprogram/assets/icons/';
  const tabs = [
    { key: 'coach', label: '教练' },
    { key: 'record', label: '记录', page: 'records' },
    { key: 'today', label: '训练', page: 'schedule' },
    { key: 'me', label: '我' },
  ];
  const expanded = new Set(['2026-11']);
  const days = ['一', '二', '三', '四', '五', '六', '日'];
  const today = 25;
  let selected = today;

  const exampleMonths = [
    { month: '2026-11', km: '22.0', duration: '2小时42分', rows: [
      { date: '2026-11-24', title: '晨跑', details: '8.03 km · 45分 · 5′36″ · 143 bpm', load: '62', sport: 'directions_run' },
      { date: '2026-11-23', title: '力量训练', details: '32分', load: '22', sport: 'fitness_center' },
      { date: '2026-11-21', title: '轻松跑', details: '13.97 km · 1小时25分 · 6′05″ · 138 bpm', load: '89', sport: 'directions_run' },
    ] },
    { month: '2026-10', km: '10.0', duration: '1小时', rows: [
      { date: '2026-10-31', title: '轻松跑', details: '10.00 km · 1小时 · 6′00″ · 140 bpm', load: '71', sport: 'directions_run' },
    ] },
  ];

  function asset(name, className = '') {
    return `<img class="${className}" src="${icons}${name}.svg" alt="" draggable="false">`;
  }

  function tabBar(active) {
    return tabs.map(({ key, label, page }) => {
      const current = key === active;
      const contents = `${asset(`tab_${key}_${current ? 'on' : 'off'}`)}<span>${label}</span>`;
      return page
        ? `<button type="button" class="mp-tab" data-action="${page}"${current ? ' aria-current="page"' : ''}>${contents}</button>`
        : `<span class="mp-tab">${contents}</span>`;
    }).join('');
  }

  function training(lesson, exerciseCount, setCount, hasDraft) {
    const weekday = days[selected - 23];
    const selectedDate = `11月${selected}日 周${weekday}`;
    const calendar = days.map((label, index) => {
      const day = 23 + index;
      return `<button type="button" class="mp-day" data-action="select-day" data-id="${day}" aria-pressed="${selected === day}" aria-label="11月${day}日 周${label}">
        <span>周${label}</span><strong>${day}</strong>
      </button>`;
    }).join('');
    return {
      title: '本周训练',
      subtitle: '(2026年11月)',
      tab: 'today',
      content: `<div class="mp-calendar" aria-label="本周日历">${calendar}</div>
        <h2 class="mp-section-title" tabindex="-1">${selected === today ? '今日' : '当日'}安排 · ${selectedDate}</h2>
        ${selected === today ? `<article class="mp-workout">
          <button type="button" class="mp-workout-open" data-action="plan" aria-label="查看${lesson}课表">
            <span class="mp-workout-title"><span class="mp-workout-icon">${asset('fitness_center')}</span><strong>${lesson}</strong><small>教练</small></span>
            <span class="mp-workout-stats">
              <span><strong>${exerciseCount}</strong><small>动作</small></span>
              <span><strong>${setCount}</strong><small>组数</small></span>
              <span><strong>25 分钟</strong><small>预计用时</small></span>
            </span>
          </button>
          <div class="mp-workout-actions" aria-hidden="true"><span>${asset('watch')}</span><span>${asset('more_horiz')}</span></div>
          <div class="mp-coach-preview" aria-hidden="true">${asset('forum')}<span>和教练聊一聊</span></div>
        </article>` : `<div class="mp-empty"><strong>当日无训练安排</strong><small>好好休息，或查看本周计划</small></div>`}
        <button type="button" class="manual-entry" data-action="manual">
          <span class="manual-entry-icon">${asset('fitness_center')}</span>
          <span><strong>${hasDraft ? '继续自由力量训练' : '自由力量训练'}</strong><small>边练边记录</small></span>
          ${asset('chevron_right', 'mp-card-arrow')}
        </button>`,
      footer: '',
    };
  }

  function monthLabel(month) {
    const [year, number] = month.split('-');
    return `${year}年${Number(number)}月`;
  }

  function dateLabel(date) {
    const [, month, day] = date.split('-');
    const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
    return `${Number(month)}月${Number(day)}日 周${'日一二三四五六'[dayOfWeek]}`;
  }

  function activityRow(row) {
    const contents = `<span class="mp-activity-icon">${asset(row.sport)}</span>
      <span class="mp-activity-info">
        <strong>${row.title}</strong><small>${dateLabel(row.date)}</small>
        <small class="mp-activity-meta">${row.id ? '手动记录' : row.details}${row.id && row.details ? ` · ${row.details}` : ''}</small>
      </span>
      ${row.load ? `<span class="mp-activity-load"><strong>${row.load}</strong><small>负荷</small></span>` : ''}`;
    return `<li>${row.id
      ? `<button type="button" class="mp-activity" data-log-action="show" data-record="${row.id}">${contents}</button>`
      : `<div class="mp-activity">${contents}</div>`}</li>`;
  }

  function records(manualRows, onlyManual) {
    const groups = new Map();
    for (const item of onlyManual ? [] : exampleMonths) groups.set(item.month, { ...item, rows: [...item.rows] });
    for (const row of manualRows) {
      const month = row.date.slice(0, 7);
      if (!groups.has(month)) groups.set(month, { month, km: '—', duration: '—', rows: [] });
      groups.get(month).rows.push({ ...row, sport: 'fitness_center' });
    }
    const months = [...groups.values()].sort((a, b) => b.month.localeCompare(a.month));
    return {
      title: '活动记录',
      subtitle: '最近训练',
      tab: 'record',
      content: months.length
        ? months.map(({ month, km, duration, rows }) => {
            const open = expanded.has(month);
            rows.sort((a, b) => b.date.localeCompare(a.date));
            return `<section class="mp-month">
              <h2><button type="button" class="mp-month-toggle" data-action="toggle-month" data-id="${month}" aria-expanded="${open}" aria-controls="month-${month}">
                <span><strong>${monthLabel(month)}</strong><small>${rows.length} 次 · ${km} km · ${duration}</small></span>
                ${asset('chevron_right')}
              </button></h2>
              <ul id="month-${month}"${open ? '' : ' hidden'}>${rows.map(activityRow).join('')}</ul>
            </section>`;
          }).join('')
        : '<div class="mp-empty"><strong>暂无活动记录</strong><small>完成一次训练后同步展示</small></div>',
      footer: '',
    };
  }

  function selectDay(day) {
    selected = day;
  }

  function toggleMonth(month) {
    if (expanded.has(month)) expanded.delete(month);
    else expanded.add(month);
  }

  function revealMonth(date) {
    expanded.add(date.slice(0, 7));
  }

  return { tabBar, training, records, selectDay, toggleMonth, revealMonth };
})();
