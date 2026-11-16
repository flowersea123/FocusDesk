import { parseArgs } from 'node:util';
import { readEml, readOutlook } from './mail-source.mjs';
import { analyzeMail, beijingMinute } from './analyze.mjs';
import { assessMail } from './assess.mjs';
import { importTask } from './task-import.mjs';
import { planChoices, saveMailPlan } from './mail-calendar.mjs';
import { readCanvasAssignments } from './canvas.mjs';

const usage = `FocusDesk 邮件与 Canvas 试用（Node 24+）
  node experiments/mail-ai/cli.mjs eml 邮件.eml [--apply]
  node experiments/mail-ai/cli.mjs outlook [--limit 5] [--apply]
  node experiments/mail-ai/cli.mjs canvas --course 课程ID [--apply]

默认预览。--apply 将符合条件的未来截止事项追加至本机 Hub。
邮件使用本机图文模型。Outlook 使用 FOCUSDESK_GRAPH_TOKEN，Canvas 使用
FOCUSDESK_CANVAS_ORIGIN 和 FOCUSDESK_CANVAS_TOKEN。详见本目录 README。`;
const hub = process.env.FOCUSDESK_HUB_URL ?? 'http://127.0.0.1:8787';
const canvasOrigin = process.env.FOCUSDESK_CANVAS_ORIGIN;
function requireSetting(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`请先在本机配置 ${name}。`);
  return value;
}
// Terminals should display text from a message, never interpret it as controls.
function visible(text) { return String(text).replace(/[\p{Cc}\p{Cf}]/gu, ' '); }

async function processMail(mail, apply) {
  const result = await analyzeMail(mail, { endpoint: process.env.FOCUSDESK_MODEL_URL, model: process.env.FOCUSDESK_MODEL_NAME });
  console.log(`\n${visible(mail.subject) || '（无标题邮件）'}\n${visible(result.summary)}`);
  const candidates = assessMail(mail, result, { canvasOrigin });
  if (!candidates.length) console.log('未提取到截止事项。');
  const choices = planChoices({ ...mail, actions: candidates.map(candidate => ({ ...candidate, verified: !candidate.reason })) });
  for (const [index, candidate] of candidates.entries()) {
    const when = candidate.dueAt ? beijingMinute(candidate.dueAt) : (candidate.dueDate ?? candidate.due_local ?? '日期待核对');
    const timeLabel = candidate.reason ? '待核对时间 ' : '';
    const sourceLabel = candidate.source === 'body' && mail.body.includes(candidate.quote) ? '邮件原句' : '模型提取文字';
    console.log(`  ${visible(candidate.title)} · ${timeLabel}${when}（北京）\n  ${sourceLabel}　${visible(candidate.quote)}`);
    if (candidate.reason) console.log(`  待核对：${candidate.reason}`);
    else if (candidate.dueAt ? Date.parse(candidate.dueAt) <= Date.now() : candidate.dueDate < beijingMinute(new Date().toISOString()).slice(0, 10)) console.log('  截止时间已过。');
    else if (!apply) console.log('  可加入待办。');
    else printImport(await saveMailPlan({ hub, ...choices[index], plannedDate: candidate.dueDate, automatic: true }));
  }
}

function printImport(result) {
  const labels = { added: '已加入待办', existing: '已有相同事项', full: '待办列表已满', review: '待核对' };
  console.log(`  ${labels[result.status]}${result.reason ? ' · ' + visible(result.reason) : ''}`);
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    apply: { type: 'boolean' }, limit: { type: 'string' }, course: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (!positionals.length || values.help) { console.log(usage); return; }
  const [command, filename] = positionals;
  if (command === 'eml' && positionals.length === 2 && !values.limit && !values.course) {
    await processMail(await readEml(filename), values.apply); return;
  }
  if (command === 'outlook' && positionals.length === 1 && !values.course) {
    const limit = Number(values.limit ?? 5);
    let failed = 0;
    const messages = await readOutlook({
      accessToken: requireSetting('FOCUSDESK_GRAPH_TOKEN'), limit,
      onMessageError({ index, reason }) {
        failed++;
        console.error(`跳过第 ${index} 封邮件 · ${visible(reason)}`);
        process.exitCode = 1;
      },
    });
    if (failed) console.log(`本次成功读取 ${messages.length} 封，跳过 ${failed} 封。`);
    else if (!messages.length) console.log('收件箱本次没有返回邮件。');
    for (const mail of messages) {
      try { await processMail(mail, values.apply); }
      catch (error) { console.error(`本封邮件处理失败 · ${visible(mail.subject)} · ${visible(error.message)}`); process.exitCode = 1; }
    }
    return;
  }
  if (command === 'canvas' && positionals.length === 1 && values.course && !values.limit) {
    const items = await readCanvasAssignments({ origin: requireSetting('FOCUSDESK_CANVAS_ORIGIN'), courseId: values.course, accessToken: requireSetting('FOCUSDESK_CANVAS_TOKEN') });
    if (!items.length) console.log('该课程本次没有返回作业。');
    for (const item of items) {
      const state = item.excused ? '免交' : item.submitted === true ? '已交' : item.submitted === null ? '提交状态待查' : '未交';
      console.log(`${visible(item.name)} · ${item.dueAt ? beijingMinute(item.dueAt) + '（北京）' : '无截止时间'} · ${state}`);
      if (values.apply && item.dueAt && Date.parse(item.dueAt) > Date.now() && !item.excused && item.submitted === false) {
        printImport(await importTask({ hub, sourceKey: item.sourceKey, title: item.name, dueAt: item.dueAt }));
      }
    }
    return;
  }
  throw new Error(usage);
}

try { await main(); }
catch (error) { console.error(visible(error.message)); process.exitCode = 1; }
