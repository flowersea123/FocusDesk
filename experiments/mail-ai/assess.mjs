import { createHash } from 'node:crypto';
import { isDeviceTaskTitle } from '../../contracts/task-update.ts';
import { deriveDeadline, deriveDeadlineDate } from './task-import.mjs';
import { canvasAssignmentKey } from './canvas.mjs';
import { beijingMinute } from './analyze.mjs';

// A proposal needs a complete original sentence for unattended import. Numbers
// transcribed from an image have no independent machine-readable source here.
export function assessMail(mail, result, { canvasOrigin } = {}) {
  const clean = value => value.trim().replace(/\s+/g, ' ');
  // Models sometimes add a typesetting space at a Han/digit boundary. Match the whole sentence
  // and keep the original spelling, punctuation and digits for evidence, dates and source IDs.
  const matchText = text => /[\r\n\u2028\u2029]/u.test(text.trim()) ? '' :
    clean(text.trim().replace(/(?<=\p{Script=Han})\p{Zs}+(?=[0-9])|(?<=[0-9])\p{Zs}+(?=\p{Script=Han})/gu, ''));
  const originals = new Map();
  for (const line of mail.body.split(/\n|(?<=[。！？!?])|(?<=\.)\s+/u)) {
    const sentence = line.trim();
    const key = matchText(sentence);
    if (key) originals.set(key, originals.has(key) ? null : sentence);
  }
  const ambiguousThread = /cancel(?:led|ed)|no longer|延期|取消|改期|不必|不用|无需|推迟|postpon|reschedul|extended|forwarded message|original message|原始邮件|转发邮件|^\s*>/im.test(mail.subject + '\n' + mail.body);
  const keys = canvasOrigin ? [...new Set((mail.sourceLinks ?? []).map(url => canvasAssignmentKey(url, canvasOrigin)).filter(Boolean))] : [];
  const proposals = result.deadlines.map(candidate => {
    const original = candidate.source === 'body' ? originals.get(matchText(candidate.quote)) : null;
    return { candidate, original, quote: original || candidate.quote };
  });
  return proposals.map(({ candidate, original, quote }) => {
    const title = candidate.title.replace(/_+/g, ' ').trim();
    const dueAt = original ? deriveDeadline(original, mail.receivedAt) : null;
    const dueDate = dueAt ? beijingMinute(dueAt).slice(0, 10) : original ? deriveDeadlineDate(original, mail.receivedAt) : null;
    const sourceKey = keys.length === 1 && result.deadlines.length === 1 ? keys[0] :
      `mail:${mail.id}:${createHash('sha256').update(clean(quote)).digest('hex')}`;
    let reason = null;
    if (candidate.source === 'image') reason = '请对照原图核对时间';
    else if (mail.images.length) reason = '请核对图片和正文是否有不同要求';
    else if (ambiguousThread) reason = '邮件包含改期、撤销或转发内容';
    else if (!original) reason = '截止原句无法与完整正文句子匹配';
    else if (!dueDate || (dueAt && beijingMinute(dueAt) !== candidate.due_local)) reason = '日期、时分或时区需要核对';
    else if (!isDeviceTaskTitle(title) || !/[A-Za-z]/.test(title)) reason = '请核对任务标题，设备需要能说明事项的英文短标题';
    else if (keys.length > 1 || (keys.length && result.deadlines.length > 1)) reason = '有多个事项或作业链接，需要核对对应关系';
    else if (proposals.filter(x => clean(x.quote) === clean(quote)).length > 1) reason = '同一句原文对应多个待办';
    return { ...candidate, quote, title, dueAt, dueDate, sourceKey, reason };
  });
}
