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
  const model = { recorder: { ...idle }, statuses: [{ ...base }, { ...paper }], actions: [] as { action: string; taskId?: string | null }[], patches: [] as unknown[] };
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    if (url === '/api/v1/recorder') {
      if (options?.method === 'POST') {
        const body = JSON.parse(options.body as string); model.actions.push(body);
        if (body.action === 'target') model.recorder = { ...model.recorder, targetTaskId: body.taskId };
        else model.recorder = { ...model.recorder, state: body.action === 'start' ? 'recording' : 'idle' };
      }
      return Response.json(model.recorder);
    }
    if (url === '/api/v1/project-progress') return Response.json({ config: { pinned: null, revision: 'one', plans: [] }, statuses: model.statuses });
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
const select = (name: string) => fireEvent.click(screen.getByRole('button', { name: name ? '查看 ' + name + ' 进度' : '跟随识别结果' }));

test('default start has no task hint, auto-follows the observed task, and distinguishes reading position from completed steps', async () => {
  const model = fixture(); mount(); await act(async () => {});
  expect(screen.getAllByRole('button', { name: '开始记录' })).toHaveLength(1);
  await click('开始记录');
  expect(model.actions).toEqual([{ action: 'start' }]);
  model.recorder = { ...model.recorder, observedTaskId: 'read', observedAt: at, savedCount: 1, lastSavedAt: at };
  await refresh();
  const card = screen.getByRole('region', { name: /^大任务进度/ });
  expect(screen.getByRole('region', { name: '今日任务' })).toHaveTextContent('最近识别的任务 Read paper');
  expect(within(card).getByRole('progressbar', { name: 'Read paper阅读位置' })).toHaveAttribute('aria-valuenow', '50');
  expect(within(card).getByRole('progressbar', { name: 'Read paper整体进度' })).toHaveAttribute('aria-valuenow', '20');
  expect(card).toHaveTextContent('第 6 / 12 页'); expect(card).toHaveTextContent('1 / 5 个步骤已完成');
  expect(card).toHaveTextContent('读到 Method');
  await click('确认已读 Method'); expect(model.patches).toEqual([{ id: 'book', readingSection: 'Method' }]);
  select('Prepare slides');
  expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
  await click('用当前录制核对这项任务');
  expect(model.actions.at(-1)).toEqual({ action: 'target', taskId: 'slides' });
  expect(card).toHaveTextContent('正用「Prepare slides」核对截图');
  await click('恢复自动识别');
  expect(model.actions.at(-1)).toEqual({ action: 'target', taskId: null });
  select(''); expect(within(card).getByRole('progressbar', { name: 'Read paper阅读位置' })).toBeVisible();
  model.recorder = { ...model.recorder, observedAt: '2026-11-16T08:12:00Z', observedTaskId: null };
  await refresh();
  expect(screen.getByRole('region', { name: '今日任务' })).toHaveTextContent('最近画面未匹配任务');
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
  const card = screen.getByRole('region', { name: /^大任务进度/ });
  expect(card).toHaveTextContent('读到 Method'); expect(card).not.toHaveTextContent('%');
  expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
  select('Prepare slides');
  expect(card).toHaveTextContent('正在编辑第 3 张幻灯片的标题。');
  expect(card).not.toHaveTextContent('进度待确认'); expect(card).not.toHaveTextContent('%');
  model.recorder = { ...model.recorder, observedTaskId: 'read', observedAt: '2026-11-16T08:16:00Z' };
  await refresh();
  expect(screen.getByRole('region', { name: '今日任务' })).toHaveTextContent('最近识别的任务 Read paper');
  expect(card).toHaveTextContent('正在编辑第 3 张幻灯片的标题。');
});
