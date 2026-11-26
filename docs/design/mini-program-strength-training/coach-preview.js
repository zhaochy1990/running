'use strict';

const coachPreview = (() => {
  const { escapeHTML } = miniProgramHome;
  const sessions = new Map();
  let recordId = null;

  function open(id = null) {
    recordId = id;
  }

  function view() {
    const record = manualLog.coachRecords().find(item => item.id === recordId);
    const messages = sessions.get(recordId) ?? [];
    return {
      title: '教练',
      tab: 'coach',
      content: `
        ${record ? `<p class="coach-context">正在围绕「${escapeHTML(record.title)}」对话</p>` : ''}
        <div class="coach-messages" role="log" aria-label="教练对话">
          <p class="coach-message">${record ? '想聊这次训练的哪一部分？' : '可以问我「最近一次力量训练练得怎么样？」'}</p>
          ${messages.map(({ text, fromUser }) => `<p class="coach-message${fromUser ? ' is-user' : ''}">${escapeHTML(text)}</p>`).join('')}
        </div>`,
      footer: `
        <form id="coach-preview-form" class="coach-preview-composer">
          <input name="message" aria-label="和教练聊天" placeholder="问问教练…" required maxlength="500">
          <button class="primary" type="submit">发送</button>
        </form>`,
    };
  }

  function summarize(record) {
    const actions = record.exercises.map(exercise => `${exercise.name}，${exercise.sets.join('、')}`);
    const note = record.note.trim() ? `\n训练备注｜${record.note.trim()}` : '';
    return `我先看这条手动记录「${record.title}」。\n${actions.join('\n')}${note}`;
  }

  function reply(message, includeWatch) {
    const manual = manualLog.coachRecords();
    if (recordId !== null) return summarize(manual.find(record => record.id === recordId));

    const day = message.includes('今天') ? manualLog.today() : message.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const relevant = record => !day || record.date === day;
    const matching = manual.filter(relevant).sort((a, b) => b.endedAt.localeCompare(a.endedAt));
    if (matching.length > 1 && day && !message.includes('最近一次')) {
      return `这一天有 ${matching.length} 条手动力量记录。可以在「记录」里打开要复盘的那一条，点「和教练聊一聊」。`;
    }
    if (matching.length) return summarize(matching[0]);

    const watch = includeWatch && miniProgramHome.watchStrength().find(relevant);
    if (watch) return `这段时间可以参考 ${watch.date} 的手表同步记录「${watch.title}」（${watch.details}）。`;
    return '这段时间还没有可供复盘的力量训练记录。';
  }

  function send(message, includeWatch) {
    const messages = sessions.get(recordId) ?? [];
    messages.push({ text: message, fromUser: true }, { text: reply(message, includeWatch), fromUser: false });
    sessions.set(recordId, messages);
  }

  return { open, view, send };
})();
