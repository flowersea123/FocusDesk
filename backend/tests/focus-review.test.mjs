import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFocusReview } from '../src/focus-review.ts';
import { createOverviewLoader } from '../src/overview-loader.ts';

const min = 60_000;
const localMidnight = Date.parse('2026-11-17T00:00:00+08:00');
const task = { id: 'lab', title: 'Finish lab', due_at: null, status: 'todo' };
const source = { date: '2026-11-16', timezone: 'Asia/Shanghai', tasks: [task] };

async function setup(t, at = localMidnight - 10 * min) {
  const dir = await mkdtemp(path.join(os.tmpdir(), '专注回顾-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.json');
  await writeFile(file, JSON.stringify(source));
  const now = () => at;
  const make = () => createFocusReview(file, { now });
  const loader = createOverviewLoader(file, { now });
  const review = make();
  return { dir, file, loader, review, make, advance: ms => { at += ms; },
    async start() {
      const current = await loader.load();
      const active = await loader.updateFocus({ action: 'start', task_id: task.id, revision: current.revision });
      await review.observe(active, 'start');
      return active;
    },
  };
}

test('a real Hub timer crossing local midnight is split by day and recovered at scheduled expiry after restart', async t => {
  const { make, start, review, loader, advance } = await setup(t);
  await start();
  advance(4 * min);
  await review.observe(await loader.load());
  advance(30 * min);
  const recovered = make();
  const projected = await loader.load();
  assert.equal(projected.focus, null);
  await recovered.observe(projected);
  const yesterday = await recovered.read('2026-11-16');
  const today = await recovered.read();
  assert.equal(yesterday.sessions.length, 1);
  assert.equal(yesterday.totalSeconds, 600);
  assert.equal(yesterday.sessions[0].end, 'continued');
  assert.equal(today.date, '2026-11-17');
  assert.equal(today.totalSeconds, 900);
  assert.equal(today.sessions[0].end, 'expired');
  assert.equal(today.sessions[0].title, 'Finish lab');
  assert.equal((await recovered.read('2026-11-16', 'UTC')).totalSeconds, 1500);
  await recovered.observe(projected);
  assert.deepEqual(await recovered.read(), today);
});

test('manual stop or completing the focused task closes once at the confirmed change', async t => {
  const { start, loader, review, advance } = await setup(t, localMidnight);
  const active = await start();
  advance(70_510);
  const stopped = await loader.updateFocus({ action: 'stop', revision: active.revision });
  await review.observe(stopped, 'stop');
  advance(min);
  await review.observe(stopped);
  const second = await start();
  advance(35_490);
  const completed = await loader.update({ revision: second.revision, tasks: [{ ...task, status: 'done' }] });
  await review.observe(completed);
  await review.observe(completed);
  const result = await review.read();
  assert.equal(result.totalSeconds, 106);
  assert.deepEqual(result.sessions.map(s => s.seconds), [70, 35]);
  assert.deepEqual(result.sessions.map(s => s.end), ['stopped', 'stopped']);
});

test('missing days have no invented sessions; enabled midway starts coverage at the first observation', async t => {
  const { make, loader, advance } = await setup(t, localMidnight);
  const active = await loader.updateFocus({ action: 'start', task_id: task.id, revision: (await loader.load()).revision });
  advance(8 * min);
  const review = make();
  advance(min);
  await review.observe(active);
  advance(2 * min);
  const result = await review.read();
  assert.equal(result.totalSeconds, 120);
  assert.equal(result.sessions[0].end, 'running');
  assert.equal(result.sessions[0].from, new Date(localMidnight + 9 * min).toISOString());
  const earlier = await review.read('2026-11-15');
  assert.equal(earlier.sessions.length, 0);
  assert.equal(earlier.partial, true);
  assert.equal(earlier.suggestion, null);
});

test('a changed source while offline never fills an unknown tail from the planned timer', async t => {
  const { start, loader, advance, file, review, make } = await setup(t, localMidnight);
  await start();
  advance(3 * min);
  await review.observe(await loader.load());
  advance(3 * min);
  await writeFile(file, JSON.stringify(source));
  advance(30 * min);
  const recovered = make();
  await recovered.observe(await loader.load());
  const result = await recovered.read();
  assert.equal(result.totalSeconds, 180);
  assert.equal(result.sessions[0].end, 'unobserved');
});

test('retains a day-scoped projection of confirmed observations and a grounded next action', async t => {
  const { review } = await setup(t, localMidnight + min);
  const first = new Date(localMidnight).toISOString();
  const rows = [
    { id: 'y', at: new Date(localMidnight - 1).toISOString(), summary: '昨天' },
    { id: 'a', at: first, summary: '两页草稿已确认。', nextStep: '校对第二页。', rawImage: 'PRIVATE-IMAGE' },
    { id: 'future', at: new Date(localMidnight + 2 * min).toISOString(), summary: '未来' },
  ];
  const result = await review.read(undefined, 'Asia/Shanghai', rows);
  assert.deepEqual(result.observations, [{ id: 'a', at: first, source:'manual', summary: '两页草稿已确认。', nextStep: '校对第二页。' }]);
  assert.equal(result.suggestion.action, '校对第二页。');
  assert.ok(result.suggestion.evidence.includes('两页草稿'));
  assert.ok(result.summary.includes('确认'));
  const automatic = await review.read(undefined, 'Asia/Shanghai', [{ id:'auto', at:first, source:'automatic', summary:'屏幕显示新批注。', nextStep:'核对批注。' }]);
  assert.equal(automatic.observations[0].source, 'automatic');
  assert.match(automatic.summary, /最近一次自动记录/);
  assert.doesNotMatch(automatic.suggestion.evidence, /确认/);
  assert.equal(JSON.stringify(result).includes('PRIVATE-IMAGE'), false);
  assert.equal(result.totalSeconds, 0);
});

test('journal is bounded in time and records a revisable, optimistic experiment with conflict-safe saves', async t => {
  const { start, review, make, advance } = await setup(t, localMidnight);
  await start();
  const req = { date: '2026-11-17', plan: '先写三条结论', revision: 'none' };
  const changes = await Promise.allSettled([review.setExperiment(req), review.setExperiment({ ...req, plan: '只写一条' })]);
  assert.deepEqual(changes.map(r => r.status), ['fulfilled', 'rejected']);
  assert.equal(changes[1].reason.status, 409);
  const recorded = (await make().read(req.date)).experiment;
  advance(24 * 60 * min);
  assert.equal((await review.read()).previousExperimentDate, req.date);
  const next = await review.setExperiment({ ...req, revision: recorded.revision, outcome: '写完两条，第三条移到明天' });
  assert.notEqual(next.revision, recorded.revision);
  assert.deepEqual((await make().read(req.date)).experiment, next);
  assert.equal((await review.read()).previousExperimentDate, null);
  await assert.rejects(review.setExperiment({ ...req, plan: ' ' }), e => e.status === 400);
  await assert.rejects(review.read('2026-02-31'), e => e.status === 400);
  await assert.rejects(review.read('2027-01-01'), e => e.status === 400);
  advance(91 * 24 * 60 * min);
  await review.observe({ ...source, focus: null });
  const pruned = await review.read(req.date);
  assert.equal(pruned.sessions.length, 0);
  assert.equal(pruned.experiment, null);
});

test('a corrupt record is preserved; an interrupted staging write can be safely retried', async t => {
  const { dir, file, loader, review, make } = await setup(t, localMidnight);
  const data = file + '.focus-review.json';
  await writeFile(data, '{"version":1,"since":"broken"}');
  const current = await loader.load();
  await assert.rejects(review.observe(current), e => e.status === 503);
  await assert.rejects(review.setExperiment({ date: '2026-11-17', plan: 'test', revision: 'none' }), e => e.status === 503);
  assert.equal(await readFile(data, 'utf8'), '{"version":1,"since":"broken"}');
  await rm(data);
  await writeFile(path.join(dir, '.' + path.basename(data) + '.tmp'), 'uncommitted');
  await review.setExperiment({ date: '2026-11-17', plan: '重新尝试', revision: 'none' });
  assert.equal((await make().read()).experiment.plan, '重新尝试');
  assert.deepEqual((await readdir(dir)).sort(), ['tasks.json', 'tasks.json.focus-review.json']);
});
