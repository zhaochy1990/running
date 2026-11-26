'use strict';

const coachPreview = (() => {
  const { escapeHTML } = miniProgramHome;
  const sessions = new Map();
  let recordId = null;

  function open(id = null) {
    const changed = recordId !== id;
    recordId = id;
    return changed;
  }

  function messageView({ text, fromUser }) {
    return `<p class="coach-message${fromUser ? ' is-user' : ''}"><span class="coach-speaker">${fromUser ? '你：' : '教练：'}</span>${escapeHTML(text)}</p>`;
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
          ${messageView({ text: record ? '想聊这次训练的哪一部分？' : '可以问我「最近一次力量训练练得怎么样？」' })}
          ${messages.map(messageView).join('')}
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

  function requestedDay(message) {
    const explicit = message.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (explicit) return explicit;
    const offset = [/今天|今日/, /昨天|昨日/, /前天/].findIndex(pattern => pattern.test(message));
    return offset < 0 ? undefined : manualLog.today(new Date(Date.now() - offset * 86_400_000));
  }

  function reply(message, includeWatch) {
    const manual = manualLog.coachRecords();
    if (recordId !== null) return summarize(manual.find(record => record.id === recordId));

    const day = requestedDay(message);
    if (!day && !message.includes('最近')) return '试试问今天、昨天或最近一次的力量训练，也可以直接写日期。';
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
    const exchange = [{ text: message, fromUser: true }, { text: reply(message, includeWatch), fromUser: false }];
    messages.push(...exchange);
    sessions.set(recordId, messages);
    return exchange.map(messageView).join('');
  }

  return { open, view, send };
})();
