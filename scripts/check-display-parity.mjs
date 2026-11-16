import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildProjectDisplay, buildDisplaySnapshot, rasterizeDisplaySnapshot, DISPLAY_PALETTE } from '../contracts/display-snapshot.ts';

const renderer = process.argv[2];
if (!renderer) throw new Error('Pass the host renderer executable built from tests/firmware/v02_snapshot_test.cpp');
const destination = path.resolve(process.argv[3] ?? '.cache/v02-parity');
await mkdir(destination, { recursive: true });
const overview = {
  schema_version: '1.0', revision: 'synthetic-v02', date: '2026-11-11', timezone: 'UTC', updated_at: '2026-11-11T10:00:00.000Z',
  tasks: [
    { id: 'write', title: 'Write the first draft', status: 'todo', due_at: null },
    { id: 'review', title: 'Review with the team', status: 'todo', due_at: null },
    { id: 'plan', title: 'Plan the next session', status: 'done', due_at: null },
  ],
  work_state: { goal: 'Make room for deep work', current_action: 'Write the first draft', next_action: 'Review with the team' },
  signals: [],
};
const variants = {
  overview,
  legacy: { ...overview, work_state: undefined, signals: undefined },
  empty: { ...overview, tasks: [], work_state: undefined },
  done: { ...overview, tasks: overview.tasks.map(task => ({ ...task, status: 'done' })) },
  long: { ...overview, tasks: overview.tasks.map(task => ({ ...task, title: 'W'.repeat(40) })), work_state: { goal: 'W'.repeat(64), current_action: 'j'.repeat(64), next_action: 'Long words with breaks '.repeat(3) } },
  draft: { ...overview, tasks: [{ ...overview.tasks[0], title: '中文 Draft' }], work_state: { goal: '中文 Draft', current_action: '', next_action: '()[]{}!~^_j' } },
  focus: { ...overview, focus: { task_id: 'review', started_at: overview.updated_at, ends_at: '2026-11-11T10:25:00.000Z' } },
  photo: { ...overview, date: '2026-11-07', tasks: [
    { id: 'homework', title: 'homework', status: 'done', due_at: null },
    { id: 'lab', title: 'lab report', status: 'todo', due_at: null },
    { id: 'assignment', title: 'assignment', status: 'done', due_at: null },
  ] },
  single: { ...overview, tasks: [overview.tasks[0]] },
  'ai-english': { ...overview, ai_suggestion: 'Draft the outline.\nFocus for 25 minutes.' },
  'ai-long': { ...overview, ai_suggestion: 'W'.repeat(120) },
  'ai-cleared': { ...overview, ai_suggestion: '' },
  'ai-unsupported': { ...overview, ai_suggestion: '先完成项目提纲' },
  'ai-paragraphs': { ...overview, ai_suggestion: 'First\nSecond\nThird' },
  'ten-tasks': { ...overview, revision: 'a'.repeat(64), ai_suggestion: 'W'.repeat(120),
    tasks: Array.from({ length: 10 }, (_, index) => ({ ...overview.tasks[0], id: `task-${index}`, title: 'W'.repeat(40) })),
    focus: { task_id: 'task-9', started_at: overview.updated_at, ends_at: '2026-11-11T10:25:00.000Z' } },
};
for (const priority of ['normal', 'action_needed', 'urgent']) {
  variants[priority] = { ...overview, signals: [{ id: 'manual-1', content: 'Review the prototype at 14:00', source: 'Manual', created_at: overview.updated_at, priority, status: 'active' }] };
}
for (const status of ['acknowledged', 'ignored', 'closed']) {
  variants[status] = { ...variants.urgent, signals: variants.urgent.signals.map(signal => ({ ...signal, status })) };
}
const scenes = Object.fromEntries(Object.entries(variants).map(([name, overview]) => [name, buildDisplaySnapshot(overview)]));
const project = { taskId:'paper', title:'Read the paper', total:5, remaining:[], evidence:null };
for (const [name, percent, completed] of [
  ['project-unknown', null, []], ['project-empty', 0, []],
  ['project-paper', 40, ['Introduction', 'Method']],
  ['project-full', 100, ['摘要', 'Introduction', 'Methods', 'Results', 'Discussion', 'Conclusion']],
]) {
  scenes[name] = buildProjectDisplay({ ...project, percent, completed }, 'project:' + name);
}
scenes['project-automatic'] = buildProjectDisplay({
  ...project, total: null, percent: 75, evidenceSource: 'automatic',
  completed: ['Introduction', 'Method'], automaticParts: ['Method'],
}, 'project:automatic');
const readingPage = {page:6, total:12, document:'Example Paper', section:'Method'};
scenes['reading-position'] = buildProjectDisplay({...project, percent:null, total:null, completed:[],
  readingPosition:readingPage},'project:reading-position');
scenes['reading-and-completion'] = buildProjectDisplay({...project, percent:40, completed:['Introduction','Method'],
  automaticParts:['Method'], readingPosition:readingPage},'project:reading-and-completion');
scenes['reading-section-only'] = buildProjectDisplay({...project, percent:0, completed:[],
  readingBookmark:{current:{section:'2. 方法'}}},'project:reading-section-only');
scenes['reading-long-page-count'] = buildProjectDisplay({...project, percent:100, completed:['Alpha','Beta','Gamma','Delta','Epsilon','Zeta'],
  readingPosition:{page:100000,total:100000,document:'W'.repeat(180)}},'project:reading-long-page-count');
for (const [name, scene] of Object.entries(scenes)) {
  const source = path.join(destination, `${name}.json`);
  const raw = path.join(destination, `${name}.raw`);
  await writeFile(source, JSON.stringify(scene));
  const result = spawnSync(path.resolve(renderer), [source, raw], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${name}: ${result.stderr || result.error || result.stdout}`);
  const expected = rasterizeDisplaySnapshot(scene);
  const actual = await readFile(raw);
  if (!actual.equals(expected)) {
    const first = actual.findIndex((color, index) => color !== expected[index]);
    throw new Error(`${name}: pixel mismatch at ${first % 400},${Math.floor(first / 400)}`);
  }
  const rgb = Buffer.alloc(400 * 300 * 3);
  actual.forEach((color, index) => rgb.set(DISPLAY_PALETTE[color], index * 3));
  await writeFile(path.join(destination, `${name}.ppm`), Buffer.concat([Buffer.from('P6\n400 300\n255\n'), rgb]));
  console.log(`PASS ${name}: 120000/120000 pixels identical`);
}
await writeFile(path.join(destination, 'result.json'), JSON.stringify({ cases: Object.keys(scenes), pixelsPerCase: 120000, matched: true }, null, 2));
