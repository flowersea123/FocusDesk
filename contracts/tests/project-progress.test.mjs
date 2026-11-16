import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStatus, validSections } from '../project-progress.ts';
import { buildProjectDisplay } from '../display-snapshot.ts';
const task={id:'paper',title:'Read the paper',status:'todo',due_at:null};
const plan={taskId:'paper',sections:['摘要 | Abstract','Introduction','Method','Results','Discussion']};
const row=(parts,at='2026-11-16T03:00:00.000Z')=>({taskId:'paper',capturedAt:at,summary:'Working on this paper',progress:null,completedParts:parts});

test('deduplicates confirmed sections, matches named aliases, computes whole-task progress and lists the parts under the bar',()=>{
  const rows=[row(['Introduction','2. Methods']),row(['摘要', 'Method']),{...row(['Discussion']),taskId:'another'}];
  const project=projectStatus(task,plan,rows);
  assert.equal(project.percent,60);assert.equal(project.total,5);assert.equal(project.completed.length,3);
  const snap=buildProjectDisplay(project,'project:test');
  const labels=snap.commands.filter(c=>c[0]===1).map(c=>c[5]);
  assert.deepEqual(labels.slice(-3),['Abstract','Introduction','Method']);
  assert.ok(labels.includes('60%'));
  assert.equal(snap.commands.find(c=>c[0]===0&&c[5]===2)[3],216);
  assert.ok(JSON.stringify(snap).length<=4096); assert.ok(snap.commands.length<=64);
  assert.equal(validSections(['Method','Methods']),false);
  assert.equal(validSections(['阅读结论 | Read conclusion']),true);
});
test('preserves unknown progress for a page heading, and uses latest evidenced percentage in the absence of a checklist',()=>{
  const latest={...row(['Introduction']), progress:{percent:50,evidence:'Paper: 2/4 sections complete'}};
  assert.equal(projectStatus(task,undefined,[row([])]).percent,null);
  assert.equal(projectStatus(task,undefined,[latest]).percent,50);
  assert.equal(projectStatus(task,plan,[latest]).percent,20);
});

test('marks automatic evidence on Hub and device, and gives a reviewed part precedence across aliases', () => {
  const auto = {...row(['Method', '引言']), source:'automatic', progress:{percent:50,evidence:'2/4 complete'}};
  const reviewed = row(['Introduction']);
  const planned = projectStatus(task, plan, [auto,reviewed]);
  assert.deepEqual(planned.automaticParts,['Method']);
  assert.equal(planned.percent,40);
  const observed = projectStatus(task, undefined, [reviewed,auto]);
  assert.deepEqual(observed.automaticParts,['Method']);
  assert.equal(observed.evidenceSource,'automatic');
  const labels = buildProjectDisplay(observed,'test').commands.filter(c=>c[0]===1).map(c=>c[5]);
  assert.equal(labels.filter(s=>s==='AUTO').length,1);
  assert.ok(labels.includes('Auto-recorded'));
});

test('bookmark movements track the latest section and only explicit reader confirmations advance progress', () => {
  const reading = (id, section, minute, document = 'The Paper') => ({
    ...row([], '2026-11-16T03:'+minute+':00.000Z'),id,source:'automatic',readingSection:section,readingDocument:document});
  const intro = reading('a','Introduction','00');
  const method = reading('b','Method','01');
  const methodAgain = reading('c','Methods','02');
  const initial = projectStatus(task,plan,[methodAgain,method,intro]);
  assert.equal(initial.readingBookmark.current.id,'c');
  assert.equal(initial.readingBookmark.previous.id,'a');
  assert.equal(initial.percent,0);
  assert.deepEqual(initial.completed,[]);
  const updated = projectStatus(task,plan,[{...intro,readingConfirmed:true},method]);
  assert.equal(updated.percent,20);
  assert.deepEqual(updated.completed,['Introduction']);
  assert.deepEqual(updated.automaticParts,[]);
  assert.equal(updated.readingBookmark.previous.confirmed,true);
  assert.equal(updated.readingBookmark.previous.source,'automatic');
  assert.ok(buildProjectDisplay(updated,'display:reading').commands.some(cmd => cmd[0]===1 && cmd[5]==='Introduction'));
  assert.equal(projectStatus(task,undefined,[intro,method]).percent,null);
  assert.equal(projectStatus(task,plan,[intro,{...method,taskId:'another'}]).readingBookmark.current.id,'a');
  assert.equal(projectStatus(task,plan,[method,{...intro,capturedAt:'2026-11-16T04:00:00.000Z'}]).readingBookmark.previous,undefined);
  assert.equal(projectStatus(task,undefined,[intro,method,{...intro,capturedAt:'2026-11-16T04:00:00.000Z'}]).readingBookmark.previous,undefined);
  assert.equal(projectStatus(task,plan,[intro,{...method,readingDocument:'Another paper'}]).readingBookmark.previous,undefined);
  const separate = projectStatus(task,plan,[{...intro,readingConfirmed:true},{...method,readingDocument:'Another paper',readingSection:'Introduction'}]);
  assert.equal(separate.readingBookmark.current.confirmed,false);
  assert.equal(separate.percent,20);
  assert.equal(projectStatus(task,plan,[{...intro,readingDocument:undefined},{...method,readingDocument:undefined}]).readingBookmark.previous,undefined);
});

const pageRow = (at, section, page, document = 'Example Paper') => ({
  ...row([], '2026-11-16T03:' + at + ':00.000Z'), id:'page-'+at, source:'automatic',
  readingDocument:document, ...(section ? {readingSection:section} : {}), ...(page ? {readingPosition:page} : {}),
});

test('the latest visible page can move backwards, and document position is separate from task completion', () => {
  const open = pageRow('02','Method',{page:6,total:12});
  const laterTitle = {...pageRow('05','Discussion',{page:12,total:12}),summary:'Window title only',detailSource:'window-title'};
  const unbound = {...pageRow('06','Results',{page:10,total:12}),taskId:'different'};
  const observations = [unbound, laterTitle, open, pageRow('01','Method',{page:8,total:12})];
  const noPlan = projectStatus(task,undefined,observations);
  assert.deepEqual(noPlan.readingPosition,{page:6,total:12,document:'Example Paper',section:'Method'});
  assert.equal(noPlan.percent,null);
  assert.deepEqual(noPlan.completed,[]);
  assert.deepEqual(noPlan.latestObservation,{summary:open.summary,capturedAt:open.capturedAt,source:'automatic'});
  const withPlan = projectStatus(task,plan,[...observations, row(['Abstract','Introduction'])]);
  assert.equal(withPlan.percent,40);
  const text = buildProjectDisplay(withPlan,'both').commands.filter(c=>c[0]===1).map(c=>c[5]);
  for (const label of ['READING POSITION','Page 6/12','50%','Section: Method','TASK COMPLETION','40%','2 / 5 parts','Abstract','Introduction']) {
    assert.ok(text.includes(label),label);
  }
  const atEnd = projectStatus(task,plan,[pageRow('01',undefined,{page:12,total:12})]);
  assert.equal(atEnd.percent,0);
  assert.deepEqual(atEnd.completed,[]);
});

test('only the same document and same normalized section can retain the last known page', () => {
  const numbered = pageRow('00','2. Methods',{page:6,total:12});
  const position = (...rows) => projectStatus(task,undefined,[numbered,...rows]);
  const same = position(pageRow('01','方法',undefined,' EXAMPLE  PAPER '));
  assert.equal(same.readingPosition.page,6);
  assert.equal(same.readingPosition.section,'方法');
  for (const latest of [pageRow('01','Results'),pageRow('01','Method',undefined,'Another paper'),
    {...pageRow('01','Method'),readingDocument:undefined}]) {
    const result = position(latest);
    assert.equal(result.readingPosition,undefined);
    assert.equal(result.readingBookmark.current.section,latest.readingSection);
  }
  const onlyPage = position(pageRow('01',undefined,{page:7,total:12}));
  assert.deepEqual(onlyPage.readingPosition,{page:7,total:12,document:'Example Paper'});
  assert.equal(onlyPage.readingBookmark,undefined);
  const otherDoc = position(pageRow('01',undefined,{page:6,total:12},'Another paper'));
  assert.equal(otherDoc.readingBookmark,undefined);
  assert.equal(otherDoc.readingPosition.document,'Another paper');
  assert.equal(position(pageRow('01',undefined,{page:6,total:12})).readingPosition.section,'2. Methods');
  assert.equal(projectStatus(task,undefined,[pageRow('00',undefined,{page:2,total:12}),pageRow('01','Method')]).readingPosition,undefined);
  for (const invalid of [{page:0,total:12},{page:4,total:3},{page:1.5,total:2},{page:10,total:100001}]) {
    assert.equal(projectStatus(task,undefined,[pageRow('00','Introduction',invalid)]).readingPosition,undefined);
  }
});

test('section-only reading is visible on the device, while observation summaries alone leave ordinary projects unchanged', () => {
  const labels = project => buildProjectDisplay(project,'example').commands.filter(c=>c[0]===1).map(c=>c[5]);
  const chinese = projectStatus(task,plan,[pageRow('00','2. 方法')]);
  assert.ok(labels(chinese).includes('Section: 2. Method'));
  assert.equal(labels(chinese).some(label=>label.startsWith('Page ')),false);
  const aliases = projectStatus(task,{taskId:task.id,sections:['研究设计 | Study design']},[pageRow('01','研究设计')]);
  assert.ok(labels(aliases).includes('Section: Study design'));
  const ordinary = projectStatus(task,undefined,[row([])]);
  assert.ok(ordinary.latestObservation);
  assert.equal(ordinary.readingPosition,undefined);
  assert.equal(labels(ordinary).includes('READING POSITION'),false);
  const onlyTitle = projectStatus(task,undefined,[{...row([]),detailSource:'window-title'}]);
  assert.equal(onlyTitle.latestObservation,undefined);
});
