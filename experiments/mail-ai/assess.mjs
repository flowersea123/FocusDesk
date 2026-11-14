import { createHash } from 'node:crypto';
import { isDeviceTaskTitle } from '../../contracts/task-update.ts';
import { deriveDeadline } from './task-import.mjs';
import { canvasAssignmentKey } from './canvas.mjs';
import { beijingMinute } from './analyze.mjs';

// A proposal needs a complete original sentence for unattended import. Numbers
// transcribed from an image have no independent machine-readable source here.
export function assessMail(mail, result, { canvasOrigin } = {}) {
  const clean = value => value.trim().replace(/\s+/g, ' ');
  const sentences = new Set(mail.body.split(/\n|(?<=[。！？!?])|(?<=\.)\s+/u).map(clean).filter(Boolean));
  const ambiguousThread = /cancel(?:led|ed)|no longer|延期|取消|改期|不必|不用|无需|推迟|postpon|reschedul|extended|forwarded message|original message|原始邮件|转发邮件|^\s*>/im.test(mail.subject + '\n' + mail.body);
  const keys = canvasOrigin ? [...new Set((mail.sourceLinks ?? []).map(url => canvasAssignmentKey(url, canvasOrigin)).filter(Boolean))] : [];
  return result.deadlines.map(candidate => {
    const title = candidate.title.replace(/_+/g, ' ').trim();
    const dueAt = deriveDeadline(candidate.quote, mail.receivedAt);
    const sourceKey = keys.length === 1 && result.deadlines.length === 1 ? keys[0] :
      `mail:${mail.id}:${createHash('sha256').update(clean(candidate.quote)).digest('hex')}`;
    let reason = null;
    if (candidate.source === 'image') reason = '请对照原图核对时间';
    else if (mail.images.length) reason = '请核对图片和正文是否有不同要求';
    else if (ambiguousThread) reason = '邮件包含改期、撤销或转发内容';
    else if (!sentences.has(clean(candidate.quote))) reason = '截止原句无法与完整正文句子匹配';
    else if (!dueAt || beijingMinute(dueAt) !== candidate.due_local) reason = '日期、时分或时区需要核对';
    else if (!isDeviceTaskTitle(title) || !/[A-Za-z]/.test(title)) reason = '请核对任务标题，设备需要能说明事项的英文短标题';
    else if (keys.length > 1 || (keys.length && result.deadlines.length > 1)) reason = '有多个事项或作业链接，需要核对对应关系';
    else if (result.deadlines.filter(x => clean(x.quote) === clean(candidate.quote)).length > 1) reason = '同一句原文对应多个待办';
    return { ...candidate, title, dueAt, sourceKey, reason };
  });
}
