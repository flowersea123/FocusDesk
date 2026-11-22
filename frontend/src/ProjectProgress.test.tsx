import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { parseDailyOverview } from '../../contracts/daily-overview';
import type { ProjectStatus } from '../../contracts/project-progress';
import type { RecorderStatus } from '../../contracts/foreground-recorder';
import today from '../../contracts/fixtures/today.json';
import App from './App';

const data = { ...parseDailyOverview(today), tasks: [
  { id: 'slides', title: 'Prepare slides', due_at: null, status: 'todo' as const },
  { id: 'read', title: 'Read paper', due_at: null, status: 'todo' as const },
] };
const at = '2026-11-16T08:10:00Z';
const idle: RecorderStatus = { state: 'idle', supported: true, platform: 'darwin', message: '', savedCount: 0, lastSavedAt: null, sessionStartedAt: null };
const base: ProjectStatus = { taskId: 'slides', title: 'Prepare slides', percent: null, total: null, completed: [], remaining: [], evidence: null };
const paper: ProjectStatus = { ...base, taskId: 'read', title: 'Read paper', percent: 20, total: 5, completed: ['Introduction'], remaining: [],
  readingPosition: { page: 6, total: 12, document: 'Sample Paper', section: 'Method' },
  readingBookmark: { current: { id: 'book', section: 'Method', document: 'Sample Paper', capturedAt: at, source: 'automatic', confirmed: false } },
  latestObservation: { summary: '读到实验方法的第二页。', capturedAt: at, source: 'automatic' } };
function fixture() {
  const model = { revision:'one', conflict:false, writes:[] as string[], recorder: { ...idle }, statuses: [{ ...base }, { ...paper }], actions: [] as { action: string; taskId?: string | null }[], patches: [] as unknown[] };
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    if (url === '/api/v1/recorder') {
      if (options?.method === 'POST') {
        const body = JSON.parse(options.body as string); model.actions.push(body);
        if (body.action === 'target') model.recorder = { ...model.recorder, targetTaskId: body.taskId };
        else model.recorder = { ...model.recorder, state: body.action === 'start' ? 'recording' : 'idle' };
      }
      return Response.json(model.recorder);
    }
    if (url === '/api/v1/project-progress') {
      if (options?.method === 'PUT') {
        const body = JSON.parse(options.body as string);
        model.writes.push(body.action);
        if (model.conflict || model.revision !== body.revision) return Response.json({error:'进度设置已变化，请重新载入再保存。'},{status:409});
        const task = model.statuses.find(status => status.taskId === body.taskId)!;
        const entries = task.accomplishments ?? [];
        task.accomplishments = body.action === 'add-accomplishment' ? [...entries,{text:body.text,source:'manual',removable:true}] :
          entries.filter(entry => entry.text !== body.text);
        model.revision += '1';
      }
      return Response.json({ config: { pinned: null, revision: model.revision, plans: [] }, statuses: model.statuses });
    }
    if (url === '/api/v1/checkpoints') {
      if (options?.method === 'PATCH') model.patches.push(JSON.parse(options.body as string));
      return Response.json({ records: [] });
    }
    throw new Error(url);
  });
  return model;
}
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });
const refresh = () => act(async () => { fireEvent(window, new Event('focus')); });
const click = async (name: string) => act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
const mount = () => render(<App source={{ kind: 'http', localWorkspace: true, read: async () => data }} />);
const select = (name: string) => fireEvent.click(screen.getByRole('button', { name: name ? '查看 ' + name + ' 详情' : '跟随识别结果' }));

test('default start has no task hint, auto-follows the observed task, and distinguishes reading position from completed steps', async () => {
  const model = fixture(); mount(); await act(async () => {});
  expect(screen.getAllByRole('button', { name: '开始记录' })).toHaveLength(1);
  await click('开始记录');
  expect(model.actions).toEqual([{ action: 'start' }]);
  model.recorder = { ...model.recorder, observedTaskId: 'read', observedAt: at, savedCount: 1, lastSavedAt: at };
  await refresh();
  const card = screen.getByRole('region', { name: /^Task Details/ });
  expect(screen.getByRole('region', { name: 'Today’s Tasks' })).toHaveTextContent('最近识别的任务 Read paper');
  const readingRow = screen.getByRole('button', {name:'查看 Read paper 详情'}).closest('li')!;
  expect(within(readingRow).getByRole('list', {name:'Read paper 已完成事项'})).toHaveTextContent('Introduction');
  expect(readingRow).toHaveTextContent('《Sample Paper》');
  expect(readingRow).toHaveTextContent('第 6 / 12 页');
  expect(readingRow).not.toHaveTextContent('Method');
  expect(within(readingRow).queryByRole('progressbar')).not.toBeInTheDocument();
  expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
  expect(card).toHaveTextContent('第 6 / 12 页');
  expect(card).toHaveTextContent('读到 Method');
  await click('确认已读 Method'); expect(model.patches).toEqual([{ id: 'book', readingSection: 'Method' }]);
  select('Prepare slides');
  expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
  await click('用当前录制核对这项任务');
  expect(model.actions.at(-1)).toEqual({ action: 'target', taskId: 'slides' });
  expect(card).toHaveTextContent('正用「Prepare slides」核对截图');
  await click('恢复自动识别');
  expect(model.actions.at(-1)).toEqual({ action: 'target', taskId: null });
  select(''); expect(within(card).getByText('第 6 / 12 页')).toBeVisible();
  model.recorder = { ...model.recorder, observedAt: '2026-11-16T08:12:00Z', observedTaskId: null };
  await refresh();
  expect(screen.getByRole('region', { name: 'Today’s Tasks' })).toHaveTextContent('最近画面未匹配任务');
  expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
  expect(document.querySelector('#record > summary')).toBeVisible();
  await click('停止记录'); expect(model.actions.at(-1)).toEqual({ action: 'stop' });
});

test('a section alone has no numerical completion and unquantified work shows the latest screenshot evidence', async () => {
  const model = fixture();
  model.statuses = [{ ...base, latestObservation: { summary: '正在编辑第 3 张幻灯片的标题。', capturedAt: at } },
    { ...paper, percent: null, total: null, readingPosition: undefined, completed: [] }];
  model.recorder = { ...idle, state: 'recording', observedTaskId: 'read', observedAt: at };
  mount(); await act(async () => {});
  const card = screen.getByRole('region', { name: /^Task Details/ });
  const row = screen.getByRole('button', {name:'查看 Read paper 详情'}).closest('li')!;
  expect(row).toHaveTextContent('《Sample Paper》');
  expect(row).not.toHaveTextContent(/第 \d/);
  expect(card).toHaveTextContent('读到 Method'); expect(card).not.toHaveTextContent('%');
  expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
  select('Prepare slides');
  expect(card).toHaveTextContent('正在编辑第 3 张幻灯片的标题。');
  expect(card).not.toHaveTextContent('进度待确认'); expect(card).not.toHaveTextContent('%');
  model.recorder = { ...model.recorder, observedTaskId: 'read', observedAt: '2026-11-16T08:16:00Z' };
  await refresh();
  expect(screen.getByRole('region', { name: 'Today’s Tasks' })).toHaveTextContent('最近识别的任务 Read paper');
  expect(card).toHaveTextContent('正在编辑第 3 张幻灯片的标题。');
});


test('paper window sightings remain in the task details and do not create accomplishments', async () => {
  const model = fixture();
  model.statuses = [{...base}, {...base, taskId:'read', title:'Read paper', paperVisits:{
    date:'2026-11-16', documents:2, count:4, minutes:[642,665,717],
    recent:[{title:'Methods for Visual Search',at:'2026-11-16T03:57:00Z'}],
  }}];
  mount(); await act(async () => {});
  const row = screen.getByRole('button', {name:'查看 Read paper 详情'}).closest('li')!;
  expect(row).not.toHaveTextContent('论文访问');
  expect(within(row).queryByRole('list')).not.toBeInTheDocument();
  expect(within(row).queryByRole('progressbar')).not.toBeInTheDocument();
  model.recorder = { ...idle, state:'recording', observedAt:at, observedTaskId:null };
  await refresh();
  expect(screen.getByText('最近画面未匹配任务')).toBeVisible();
  select('Read paper');
  const card = screen.getByRole('region', {name:/^Task Details/});
  fireEvent.click(within(card).getByText('论文访问记录 · 2 篇'));
  expect(within(card).getByText('Methods for Visual Search')).toBeVisible();
  expect(card).not.toHaveTextContent('暂无进度记录');
  expect(within(screen.getByRole('button', {name:'查看 Prepare slides 详情'}).closest('li')!).queryByRole('img')).not.toBeInTheDocument();
});

test('shows the latest paper and its observed page inside its own task row, including backward navigation and title-only visits', async () => {
  const model = fixture();
  const latestPaper = {id:'1706.03762', title:'Attention Is All You Need', at, position:{page:2, total:15}};
  model.statuses[1] = {...paper, completed:[], latestPaper};
  mount(); await act(async () => {});
  const row = screen.getByRole('button', {name:'查看 Read paper 详情'}).closest('li')!;
  expect(row).toHaveTextContent('《Attention Is All You Need》');
  expect(row).toHaveTextContent('第 2 / 15 页');
  expect(row).not.toHaveTextContent('Sample Paper');
  expect(within(row).queryByRole('list')).not.toBeInTheDocument();
  expect(screen.getByRole('button', {name:'查看 Prepare slides 详情'}).closest('li')).not.toHaveTextContent(latestPaper.title);
  select('Read paper');
  const card = screen.getByRole('region', {name:/^Task Details/});
  expect(card).toHaveTextContent('第 2 / 15 页');
  expect(within(card).queryByRole('button', {name:'确认已读 Method'})).not.toBeInTheDocument();

  model.statuses[1].latestPaper = {...latestPaper, position:{page:1, total:15}};
  await refresh();
  expect(row).toHaveTextContent('第 1 / 15 页');

  model.statuses[1].latestPaper = {id:'2001.00001', title:'Another paper', at};
  await refresh();
  expect(row).toHaveTextContent('《Another paper》');
  expect(row).not.toHaveTextContent(/第 \d/);
  expect(card).toHaveTextContent('Another paper');
  expect(card).not.toHaveTextContent(/第 \d/);
});

test('adds concrete accomplishments in order, preserves a conflict draft, and removes only a manual record', async () => {
  const model = fixture();
  model.statuses[0].accomplishments = [];
  mount(); await act(async () => {});
  const row = screen.getByRole('button', {name:'查看 Prepare slides 详情'}).closest('li')!;
  const inside = within(row);
  const first = '看完第一章课件并和 GPT 讨论';
  const second = '完成 Exercise 1';
  async function start(text: string) {
    fireEvent.click(inside.getByRole('button', {name:/记录已完成事项/}));
    const input = inside.getByRole('textbox');
    fireEvent.change(input, {target:{value:text}});
    return input;
  }
  const input = await start(first);
  fireEvent.keyDown(input,{key:'Enter',keyCode:229,isComposing:true});
  expect(model.writes).toHaveLength(0);
  await act(async () => {fireEvent.keyDown(input,{key:'Enter'});});
  expect(inside.getByRole('listitem')).toHaveTextContent(first);
  const another = await start(second);
  model.conflict = true; model.revision = 'elsewhere';
  await act(async () => {fireEvent.click(inside.getByRole('button',{name:'保存'}));});
  expect(inside.getByRole('alert')).toHaveTextContent('已变化');
  expect(another).toHaveValue(second);
  model.conflict = false;
  await act(async () => {fireEvent.click(inside.getByRole('button',{name:'保存'}));});
  await refresh();
  expect(inside.getAllByRole('listitem').map(item => item.querySelector('span')?.textContent)).toEqual([first,second]);
  await act(async () => {fireEvent.click(inside.getByRole('button',{name:'移除已完成事项「'+first+'」'}));});
  expect(inside.getAllByRole('listitem')).toHaveLength(1);
  expect(inside.getByRole('listitem')).toHaveTextContent(second);
  expect(inside.queryByRole('progressbar')).not.toBeInTheDocument();
});
