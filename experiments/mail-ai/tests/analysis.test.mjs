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
