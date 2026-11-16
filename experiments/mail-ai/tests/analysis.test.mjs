import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { analyzeMail } from '../analyze.mjs';
import { assessMail } from '../assess.mjs';
import { canvasAssignmentKey } from '../canvas.mjs';
import { readEml } from '../mail-source.mjs';

const school = 'https://canvas.example.edu';
const sample = new URL('../evaluation/portfolio.eml', import.meta.url);
const baseProposal = { title: 'Submit portfolio', quote: 'Please submit the design portfolio by 2026-11-16 17:00 Beijing time.', source: 'body', due_local: '2026-11-16 17:00' };
const extraction = (candidate = baseProposal) => ({ summary: '请在北京时间 11 月 16 日 17:00 前提交作品集。', deadlines: [candidate] });

test('text and image bytes go directly to the loopback model and an incomplete reply fails', async () => {
  const mail = await readEml(sample);
  const png = await readFile(new URL('../evaluation/notice-zh.png', import.meta.url));
  mail.images.push({ mime: 'image/png', data: png });
  const fetcher = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:18187/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    const { messages, response_format } = JSON.parse(options.body);
    assert.equal(response_format.type, 'json_schema');
    assert.equal(JSON.parse(messages[1].content[0].text).body, mail.body);
    assert.equal(messages[1].content[1].image_url.url, 'data:image/png;base64,' + png.toString('base64'));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(extraction()) } }] });
  };
  assert.deepEqual(await analyzeMail(mail, { fetcher }), extraction());
  await assert.rejects(analyzeMail(mail, { endpoint: 'https://external.example/', fetcher }), /本机/);
  await assert.rejects(analyzeMail(mail, { fetcher: async () => Response.json({ choices: [{ finish_reason: 'length' }] }) }), /未完成/);
});

test('accepts a precise grounded sentence, shares a verified course link and retains other tasks as candidates', async () => {
  const mail = await readEml(sample);
  mail.sourceLinks = [school + '/courses/123/assignments/789?ref=notice'];
  const [accepted] = assessMail(mail, extraction(), { canvasOrigin: school });
  assert.equal(accepted.reason, null);
  const readable = assessMail(mail, extraction({ ...baseProposal, title: 'submit_design_portfolio' }))[0];
  assert.equal(readable.title, 'submit design portfolio');
  assert.match(assessMail(mail, extraction({ ...baseProposal, title: '2026-11-16 17:00' }))[0].reason, /标题/);
  assert.equal(accepted.dueAt, '2026-11-16T09:00:00.000Z');
  assert.equal(accepted.sourceKey, canvasAssignmentKey(mail.sourceLinks[0], school));
  const [untrusted] = assessMail(mail, extraction(), { canvasOrigin: 'https://different.example' });
  assert.ok(untrusted.sourceKey.startsWith('mail:'));
  for (const change of [{ source: 'image' }, { quote: 'submit the design portfolio by 2026-11-16 17:00' }, { due_local: '2026-11-17 17:00' }]) {
    assert.ok(assessMail(mail, extraction({ ...baseProposal, ...change }))[0].reason);
  }
  const cancelled = { ...mail, body: mail.body + '\nThis request was cancelled.' };
  assert.match(assessMail(cancelled, extraction())[0].reason, /撤销/);
});

test('keeps a verified date-only deadline while a reading notice or a floating day gets a manual date choice', () => {
  const analyze = (quote, modelTime = null) => assessMail({ id: 'notice', subject: '课程通知', body: quote, receivedAt: '2026-11-16T04:00:00Z', images: [] }, {
    summary: quote, deadlines: [{ title: 'Read materials', source: 'body', quote, due_local: modelTime }],
  })[0];
  for (const quote of ['请于2026年11月27日前提交报告。', '请于本月27日前提交报告。', 'Submit the report by 2026-11-27.', '请于本月27日前阅读学生周材料。', 'Please read the course materials by 2026-11-27.']) {
    const candidate = analyze(quote);
    assert.equal(candidate.reason, null, quote);
    assert.equal(candidate.dueDate, '2026-11-27', quote);
    assert.equal(candidate.dueAt, null);
  }
  const inventedClock = analyze('Please submit the gallery draft by 2026-11-27.', '2026-11-27 09:12');
  assert.equal(inventedClock.reason, null); assert.equal(inventedClock.dueDate, '2026-11-27'); assert.equal(inventedClock.dueAt, null);
  for (const quote of ['27号有活动，请阅读通知。', '请在27号前提交报告。', '2026年11月27日讲座开始。', 'Submit by 2026-11-27 or 2026-12-01.']) {
    const candidate = analyze(quote);
    assert.ok(candidate.reason);
    assert.equal(candidate.dueDate, null);
  }
});

test('Han/digit typesetting spaces resolve to a unique complete original with its own deadline and source ID', () => {
  const read = '请于本月27日前阅读学生周材料。';
  const submit = '请于本月28日前提交课程报告。';
  const spaced = '请于本月 27 日前阅读学生周材料。';
  const assess = (body, ...quotes) => assessMail({ id: 'zh-spot', subject: '学生周', body, receivedAt: '2026-11-16T01:12:00Z', images: [] }, {
    summary: '学生周任务', deadlines: quotes.map(quote => ({ title: 'Course materials', source: 'body', quote, due_local: '2026-11-27 09:12' })),
  });
  const body = read + '\n' + submit;
  const [exact] = assess(body, read);
  const [second, first] = assess(body, '请于本月 28 日前提交课程报告。', spaced);
  assert.equal(first.reason, null);
  assert.equal(first.quote, read);
  assert.equal(first.sourceKey, exact.sourceKey);
  assert.equal(first.dueDate, '2026-11-27'); assert.equal(first.dueAt, null);
  assert.equal(second.quote, submit); assert.equal(second.dueDate, '2026-11-28');
  assert.notEqual(first.sourceKey, second.sourceKey);
  const [spacedOriginal] = assess(spaced, read);
  assert.equal(spacedOriginal.quote, spaced);
  assert.equal(spacedOriginal.sourceKey, assess(spaced, spaced)[0].sourceKey);
  assert.equal(spacedOriginal.dueDate, '2026-11-27');
  for (const changed of ['请于本月 28 日前阅读学生周材料。', '请于本月 2 7 日前阅读学生周材料。',
    '请于本月27日前阅读学生周 材料。', '请阅读学生周材料于本月27日前。', '请于本月27日前阅读学生周材料!',
    '请于本月27日前阅读学生周材料。请于本月28日前提交课程报告。', '请于本月\n27日前阅读学生周材料。']) {
    const [proposal] = assess(body, changed);
    assert.match(proposal.reason, /原句/, changed); assert.equal(proposal.dueDate, null);
  }
  assert.match(assess(read + '\n' + spaced, spaced)[0].reason, /原句/);
  assert.ok(assess(body, spaced, read).every(p => /多个待办/.test(p.reason)));
});
