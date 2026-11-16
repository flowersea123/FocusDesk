const mailPlanDrafts = new Map();
const savingMailPlans = new Set();

function mailPlanForm(choice, save, hub) {
  const form = document.createElement('form');
  form.className = 'mail-plan';
  const draft = mailPlanDrafts.get(choice.id) || {};
  let saved = choice.entry;
  let revision = draft.expectedRevision ?? choice.planRevision;
  const needsRestore = () => saved?.status === 'removed';
  const done = () => saved?.status === 'done';
  const fields = document.createElement('div');
  fields.className = 'plan-fields';
  form.append(fields);
  function field(name, caption, type, value, required) {
    const label = document.createElement('label');
    label.textContent = caption;
    const input = document.createElement('input');
    input.type = type; input.name = name; input.required = required; input.disabled = done();
    input.value = draft[name] ?? value ?? '';
    label.append(input);
    fields.append(label);
    input.addEventListener('input', () => {
      draft[name] = input.value; draft.expectedRevision = revision; mailPlanDrafts.set(choice.id, draft);
    });
    return input;
  }
  const plannedDate = field('plannedDate', '计划日', 'date', saved?.plannedDate || choice.dueDate, true);
  const dueDate = field('dueDate', '截止日（选填）', 'date', choice.dueDate || saved?.dueDate, false);
  if (choice.dueDate) { dueDate.value = choice.dueDate; dueDate.readOnly = true; }
  const title = field('title', '日历标题', 'text', saved?.title || choice.title, true);
  title.maxLength = 240;
  const short = field('deviceTitle', '设备短标题', 'text', saved?.deviceTitle || choice.deviceTitle, true);
  short.maxLength = 40; short.pattern = '[ -~]{1,40}'; short.title = '1–40 个可打印英文字符';
  const actions = document.createElement('div'); actions.className = 'plan-actions';
  form.append(actions);
  const button = document.createElement('button');
  button.type = 'submit'; button.disabled = done() || savingMailPlans.has(choice.id);
  const buttonLabel = () => done() ? '已完成' : needsRestore() ? '重新安排' : saved ? '保存改期' : '加入日历';
  button.textContent = buttonLabel();
  const state = document.createElement('span'); state.setAttribute('role', 'status'); state.className = 'hint';
  if (done()) state.textContent = '需要重新安排时，请先在今日任务中恢复待办。';
  const link = document.createElement('a'); link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = '查看这一天';
  function dayLink(value) {
    link.hidden = !value;
    if (value) link.href = new URL('/#calendar?date=' + encodeURIComponent(value), hub).href;
  }
  dayLink(needsRestore() ? null : saved?.plannedDate);
  actions.append(button, link, state);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (done() || savingMailPlans.has(choice.id)) return;
    savingMailPlans.add(choice.id); button.disabled = true; state.textContent = '正在保存…';
    try {
      const result = await save({ plannedDate: plannedDate.value, dueDate: dueDate.value || null,
        title: title.value.trim(), deviceTitle: short.value.trim(), expectedRevision: revision, restore: Boolean(needsRestore()) });
      if (!['added', 'existing'].includes(result.status)) throw Error(result.reason || '日历尚未保存。');
      saved = result.entry; revision = result.planRevision;
      mailPlanDrafts.delete(choice.id);
      state.textContent = '已安排在 ' + (result.entry?.plannedDate || plannedDate.value);
      button.textContent = '保存改期'; dayLink(result.entry?.plannedDate || plannedDate.value);
    } catch (err) {
      state.textContent = err.message;
      if (err.planRevision) {
        const latest = document.createElement('button'); latest.type = 'button'; latest.textContent = '读取最新安排';
        latest.addEventListener('click', () => {
          saved = err.current; revision = err.planRevision;
          plannedDate.value = saved?.plannedDate || choice.dueDate || '';
          dueDate.value = choice.dueDate || saved?.dueDate || '';
          title.value = saved?.title || choice.title; short.value = saved?.deviceTitle || choice.deviceTitle;
          Object.keys(draft).forEach(key => delete draft[key]);
          mailPlanDrafts.delete(choice.id); button.textContent = buttonLabel(); button.disabled = done();
          for (const input of fields.querySelectorAll('input')) input.disabled = done();
          dayLink(needsRestore() ? null : saved?.plannedDate); state.replaceChildren();
        });
        state.append(' ', latest);
      }
    }
    finally { savingMailPlans.delete(choice.id); button.disabled = done(); }
  });
  return form;
}
