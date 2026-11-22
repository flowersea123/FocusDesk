import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { RecorderStatus } from '../../contracts/foreground-recorder';
import type { ScreenCheckpoint } from '../../contracts/screen-checkpoint';
import { parseDailyOverview } from '../../contracts/daily-overview';
import today from '../../contracts/fixtures/today.json';
import App from './App';
import { RecorderButton, RecorderStatusLine, RecorderFeedback, useForegroundRecorder } from './ForegroundRecord';

const idle: RecorderStatus = { state: 'idle', supported: true, platform: 'darwin', message: '', savedCount: 0, lastSavedAt: null, sessionStartedAt: null };
const live: RecorderStatus = { ...idle, state: 'recording', sessionStartedAt: '2026-11-16T04:00:00Z' };
const flush = () => act(async () => {});
const click = (name: string) => act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
const onRecordsChanged = vi.fn();
function Controls() {
  const recorder = useForegroundRecorder(true, onRecordsChanged);
  return <><RecorderButton recorder={recorder} /><RecorderStatusLine recorder={recorder} timezone="Asia/Shanghai" />
    <RecorderFeedback recorder={recorder} /></>;
}
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); onRecordsChanged.mockClear();
  window.history.replaceState(null, '', '/');
});

test('a single button starts and stops the native session and status polling observes system-menu stops', async () => {
  vi.useFakeTimers();
  let status = idle;
  const actions: unknown[] = [];
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
    expect(path).toBe('/api/v1/recorder');
    if (options.method === 'POST') {
      const body = JSON.parse(options.body as string);
      actions.push(body); status = body.action === 'start' ? live : idle;
    }
    return Response.json(status);
  });
  render(<Controls />); await flush();
  expect(actions).toEqual([]);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  await click('开始记录');
  expect(screen.getByText('记录中')).toBeVisible();
  await click('停止记录');
  expect(screen.getByText('待机')).toBeVisible();
  await click('开始记录');
  status = { ...live, savedCount: 2, lastSavedAt: '2026-11-16T04:02:00Z' };
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(screen.getByText('本次已记 2 条')).toBeVisible();
  expect(onRecordsChanged).toHaveBeenCalledOnce();
  status = { ...status, state: 'idle', message: '已从系统菜单停止。' };
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(screen.getByRole('button', { name: '开始记录' })).toBeEnabled();
  expect(screen.getByText('已从系统菜单停止。')).toBeVisible();
  expect(actions).toEqual([{ action: 'start' }, { action: 'stop' }, { action: 'start' }]);
});

test('late reads and duplicate clicks cannot replace or repeat a start command', async () => {
  let resolveStale!: (snapshot: Response) => void;
  let resolveStart!: (snapshot: Response) => void;
  const request = vi.fn()
    .mockResolvedValueOnce(Response.json(idle))
    .mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveStart = resolve; }))
    .mockImplementation(async () => Response.json(live));
  vi.stubGlobal('fetch', request);
  render(<Controls />); await flush();
  fireEvent(window, new Event('focus'));
  const start = screen.getByRole('button', { name: '开始记录' });
  fireEvent.click(start); fireEvent.click(start);
  expect(start).toBeDisabled();
  await act(async () => { resolveStart(Response.json(live)); });
  await act(async () => { resolveStale(Response.json(idle)); });
  expect(screen.getByText('记录中')).toBeVisible();
  expect(request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
});

test('shows permission failures, unavailable platforms and malformed service responses without inventing a running session', async () => {
  const failure = '请在系统设置中允许 FocusDesk 录制屏幕，再点开始记录。';
  let status: unknown = {};
  vi.stubGlobal('fetch', async (_path: string, options: RequestInit) => {
    if (options.method === 'POST') status = { ...idle, state: 'error', message: failure };
    return Response.json(status);
  });
  render(<Controls />); await flush();
  expect(screen.getByRole('alert')).toHaveTextContent('记录状态无法读取');
  status = { ...idle, platform: 'linux', supported: false, state: 'unavailable', message: '此桌面暂不支持自动记录。' };
  await click('重新读取状态');
  expect(screen.getByText('此桌面暂不支持自动记录。')).toBeVisible();
  expect(screen.getByRole('button', { name: '开始记录' })).toBeDisabled();
  status = idle;
  await act(async () => { fireEvent(window, new Event('focus')); });
  await click('开始记录');
  expect(screen.getByRole('alert')).toHaveTextContent(failure);
  expect(screen.getByRole('button', { name: '开始记录' })).toBeEnabled();
  expect(screen.queryByText('记录中')).not.toBeInTheDocument();
});

test('a direct record link restores the running indicator, reloads the timeline and other views when records arrive, and pages older records', async () => {
  let status = live;
  const fallback: ScreenCheckpoint = { id: 'fallback', source: 'automatic', taskId: null, summary: 'Safari · 课程讲义', nextStep: '',
    appName: 'Safari', pageTitle: '课程讲义', detailSource: 'window-title', capturedAt: '2026-11-16T04:00:30Z', progress: null };
  const manual: ScreenCheckpoint = { id: 'older', taskId: 'old', capturedAt: '2026-11-15T04:00:30Z', summary: '早期手动记录', nextStep: '', progress: null };
  const analyzed = { ...fallback, id: 'model', pageTitle: '研究笔记', detailSource: undefined, summary: '整理第二章的问题。' };
  let records: ScreenCheckpoint[] = [fallback];
  const data = parseDailyOverview(today);
  const routes: string[] = [];
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    routes.push(url);
    if (url === '/api/v1/recorder') { expect(options?.method).not.toBe('POST'); return Response.json(status); }
    if (url.startsWith('/api/v1/checkpoints')) return Response.json(url.endsWith('?limit=24') ? { records: [...records, manual] } : { records, hasMore: true });
    if (url === '/api/v1/project-progress') return Response.json({ config: { revision: 'one', plans: [], pinned: null }, statuses: [] });
    if (url.startsWith('/api/v1/focus-review')) return Response.json({ date: data.date, today: data.date, timezone: data.timezone,
      trackingSince: fallback.capturedAt, partial: false, totalSeconds: 0, sessions: [], observations: [], summary: '当日记录', suggestion: null, experiment: null, previousExperimentDate: null });
    throw new Error(url);
  });
  window.history.replaceState(null, '', '/#record');
  render(<App source={{ kind: 'http', localWorkspace: true, read: async () => data }} />); await flush();
  expect(screen.getByText('屏幕记录中')).toBeVisible();
  expect(screen.getByRole('region', { name: /^Task Details/ })).toBeVisible();
  expect(screen.queryByRole('button', { name: '屏幕记录' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '今天任务' })).not.toBeInTheDocument();
  const timeline = screen.getByRole('region', { name: 'Recording Timeline' });
  expect(within(timeline).getByRole('heading', { name: '课程讲义' })).toBeVisible();
  expect(within(timeline).getByText('来自窗口标题')).toBeVisible();
  expect(within(timeline).queryByText('Safari · 课程讲义')).not.toBeInTheDocument();
  expect(document.querySelector('.checkpoint-manual')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('查看更早的记录'));
  await click('显示更早的记录');
  expect(within(timeline).getByText('早期手动记录')).toBeVisible();
  expect(within(timeline).getByText('手动确认')).toBeVisible();
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Daily Review' })); });
  const reviewsBefore = routes.filter(path => path === '/api/v1/focus-review').length;
  const progressBefore = routes.filter(path => path === '/api/v1/project-progress').length;
  records = [analyzed, ...records];
  status = { ...live, savedCount: 2, lastSavedAt: analyzed.capturedAt };
  await act(async () => { fireEvent(window, new Event('focus')); });
  expect(routes.filter(path => path === '/api/v1/focus-review').length).toBeGreaterThan(reviewsBefore);
  expect(routes.filter(path => path === '/api/v1/project-progress').length).toBeGreaterThan(progressBefore);
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Workspace' })); });
  expect(within(timeline).getByRole('heading', { name: '研究笔记' })).toBeVisible();
  expect(within(timeline).getByText('整理第二章的问题。')).toBeVisible();

  status = { ...status, state: 'idle' };
  await act(async () => { fireEvent(window, new Event('focus')); });
  expect(screen.queryByText('屏幕记录中')).not.toBeInTheDocument();
});
