import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { createMockSource, type OverviewSource } from './data/overview-source';
import { parseDailyOverview, type DailyOverview } from '../../contracts/daily-overview';
import today from '../../contracts/fixtures/today.json';

const deviceTitles = ['Zheng li jin tian de zhong dian ren wu', 'Wan cheng Dashboard ye mian yan zheng'];

afterEach(() => vi.useRealTimers());

describe('Dashboard', () => {
  it('opens the local mail page from the editable Hub without leaving the task editor', async () => {
    render(<App source={{ kind: 'http', read: vi.fn().mockResolvedValue(parseDailyOverview(today)), updateTasks: vi.fn() }} />);
    await screen.findAllByText(today.tasks[0].title);
    const mail = within(screen.getByRole('navigation')).getByRole('link', { name: '邮件与待办' });
    expect(mail).toHaveAttribute('href', `http://127.0.0.1:${Number(process.env.FOCUSDESK_TRIAL_PORT ?? 5184)}/`);
    expect(mail).toHaveAttribute('target', '_blank');
  });

  it('shows task controls and omits editors for fields outside the preview', async () => {
    const signals = (['active', 'acknowledged', 'ignored', 'closed'] as const).map((status, index) => ({
      id: `event-${index}`, content: `Manual event ${index + 1}`, source: 'Manual',
      created_at: '2026-11-11T08:00:00.000Z', priority: 'normal' as const, status,
    }));
    const data = { ...parseDailyOverview(today), signals };
    render(<App source={{ kind: 'http', read: vi.fn().mockResolvedValue(data) }} />);
    const tasks = screen.getByRole('region', { name: '今日任务' });
    await within(tasks).findByText(data.tasks[0].title, { selector: '.task-title' });
    expect(within(tasks).getAllByRole('listitem')).toHaveLength(data.tasks.length);
    expect(screen.queryByRole('region', { name: 'Signal management' })).not.toBeInTheDocument();
    for (const signal of signals) expect(screen.queryByDisplayValue(signal.content)).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link', { name: '连接设备' })) expect(link).toHaveAttribute('href', '/connect');
    expect(screen.getByRole('heading', { name: '今日工作台' })).toBeVisible();
    expect(screen.queryByLabelText('YOUR GOAL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/CURRENT ACTION/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/NEXT ACTION/)).not.toBeInTheDocument();
    expect(data.signals).toEqual(signals);
  });

  it('identifies Mock/date limits and renders a browser-only 400 by 300 design preview', async () => {
    render(<App source={createMockSource(0)} />);
    const taskRegion = screen.getByRole('region', { name: '今日任务' });
    await within(taskRegion).findByText(today.tasks[0].title);
    expect(screen.getByText('本地演示')).toBeVisible();
    expect(screen.getByText(/固定演示日期/)).toBeVisible();
    expect(screen.getByText(/浏览器内随编辑更新/)).toBeVisible();
    const preview = screen.getByRole('img', { name: '400 × 300 e-paper preview' });
    const pageTitles = within(taskRegion).getAllByRole('listitem').map(item => item.querySelector('.task-title')?.textContent);
    expect(pageTitles).toEqual(today.tasks.map(task => task.title));
    expect(screen.getByRole('link', { name: /打开模拟屏查看设备/ })).toHaveAttribute('href', '/simulator');
    expect(preview).toHaveClass('paper-design');
    expect(preview).toHaveAttribute('data-width', '400');
    expect(preview).toHaveAttribute('data-height', '300');
    expect(preview).toHaveAttribute('data-source-revision', today.revision);
    expect(preview).toHaveAttribute('data-preview-mode', 'workspace');
    expect([...preview.querySelectorAll('.preview-task-title')].map(item => item.textContent)).toEqual(deviceTitles);
    const transcript = document.getElementById('preview-transcript')!;
    expect(transcript).toHaveTextContent('FOCUSDESK');
    for (const label of deviceTitles) expect(transcript).toHaveTextContent(label);
    expect(transcript).toHaveTextContent('AI RECOMMENDATION No suggestion yet.');
    expect(screen.getByLabelText('1 项已完成，共 3 项')).toBeInTheDocument();
  });

  it('shows five sample tasks with a hidden count without saving or replacing workspace tasks', async () => {
    const user = userEvent.setup(); const data = parseDailyOverview(today); const original = structuredClone(data);
    const updateTasks = vi.fn(); const updateFocus = vi.fn(); const updateWorkState = vi.fn();
    render(<App source={{ kind: 'http', read: vi.fn().mockResolvedValue(data), updateTasks, updateFocus, updateWorkState }} />);
    await within(screen.getByRole('region', { name: '今日任务' })).findByText(data.tasks[0].title, { selector: '.task-title' });
    await user.click(screen.getByRole('button', { name: '多任务示例' }));
    const preview = screen.getByRole('img', { name: '400 × 300 e-paper preview' });
    expect(preview).toHaveAttribute('data-preview-mode', 'sample');
    expect(screen.getByRole('button', { name: '多任务示例' })).toHaveAttribute('aria-pressed', 'true');
    expect(preview.querySelectorAll('.preview-task-title')).toHaveLength(5);
    expect(preview.querySelectorAll('.paper-task.is-current')).toHaveLength(1);
    expect(preview.querySelector('.paper-task.is-current .preview-task-title')).toHaveTextContent('Finish project proposal');
    expect(document.getElementById('preview-transcript')).toHaveTextContent('+1 more');
    expect(preview.querySelector('.paper-recommendation p')).toHaveTextContent('Draft the outline, then focus for 25 min.');
    expect(document.getElementById('preview-transcript')).not.toHaveTextContent('Reply to project feedback');
    expect(updateTasks).not.toHaveBeenCalled(); expect(updateFocus).not.toHaveBeenCalled(); expect(updateWorkState).not.toHaveBeenCalled();
    expect(data).toEqual(original);
    await user.click(screen.getByRole('button', { name: '当前任务' }));
    expect(preview).toHaveAttribute('data-preview-mode', 'workspace');
    expect(preview.querySelector('.paper-recommendation p')).toHaveTextContent('No suggestion yet.');
    expect([...preview.querySelectorAll('.preview-task-title')].map(item => item.textContent)).toEqual(deviceTitles);
    expect(screen.getByRole('button', { name: '当前任务' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('replaces old tasks with a legitimate empty snapshot', async () => {
    const user = userEvent.setup();
    render(<App source={createMockSource(0)} />);
    await screen.findAllByText(today.tasks[0].title);
    await user.click(screen.getByRole('button', { name: '空列表' }));
    await waitFor(() => expect(screen.queryByText(today.tasks[0].title)).not.toBeInTheDocument());
    expect(screen.getAllByText('今天没有安排的任务')).toHaveLength(1);
    expect(screen.getByLabelText('0 项已完成，共 0 项')).toBeInTheDocument();
  });

  it('preserves the previous snapshot on failure and recovers after selecting a valid scenario', async () => {
    const user = userEvent.setup();
    render(<App source={createMockSource(0)} />);
    await screen.findAllByText(today.tasks[0].title);
    await user.click(screen.getByRole('button', { name: '读取失败' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('正在显示上次成功内容');
    expect(within(screen.getByRole('region', { name: '今日任务' })).getByText(today.tasks[0].title)).toBeVisible();
    expect(screen.getByText(today.revision)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '全部完成' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByLabelText('3 项已完成，共 3 项')).toBeInTheDocument();
  });

  it('updates both data date and revision when switching to a next-day fixture', async () => {
    const user = userEvent.setup();
    render(<App source={createMockSource(0)} />);
    await screen.findAllByText(today.tasks[0].title);
    await user.click(screen.getByRole('button', { name: '次日样例' }));
    await waitFor(() => expect(screen.queryByText(today.revision)).not.toBeInTheDocument());
    expect(screen.getByText('2026-11-03', { selector: 'time' })).toHaveAttribute('datetime', '2026-11-03');
    expect(screen.getByText('星期二')).toBeVisible();
    expect(screen.getByText(/固定演示日期/)).toBeVisible();
  });

  it('shows initial loading, then an explicit failure without inventing empty data, and supports retry', async () => {
    let rejectRead!: (reason: Error) => void;
    const read = vi.fn<OverviewSource['read']>()
      .mockImplementationOnce(() => new Promise<DailyOverview>((_resolve, reject) => { rejectRead = reject; }))
      .mockResolvedValueOnce(parseDailyOverview(today));
    render(<App source={{ kind: 'mock', read }} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在读取今日概览');
    await act(async () => { rejectRead(new Error('Network unavailable')); });
    expect(screen.getByRole('alert')).toHaveTextContent('暂无可显示内容');
    expect(screen.queryByText('今天没有安排的任务')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '重试' }));
    await screen.findAllByText(today.tasks[0].title);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not allow Mock scenario switches while consuming HTTP', async () => {
    const source: OverviewSource = { kind: 'http', read: vi.fn().mockResolvedValue(parseDailyOverview(today)) };
    render(<App source={source} />);
    await screen.findAllByText(today.tasks[0].title);
    expect(screen.getByText('只读 Hub')).toBeVisible();
    expect(screen.getByText(/工作台日期取自任务文件/)).toBeInTheDocument();
    expect(screen.getByText(/请在本机打开 FocusDesk 编辑任务/)).toBeVisible();
    expect(screen.queryByRole('link', { name: '邮件与待办' })).not.toBeInTheDocument();
    expect(screen.queryByText(/尚待成员 B/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '空列表' })).not.toBeInTheDocument();
  });

  it('polls HTTP serially, preserves content on consecutive failures, backs off, and recovers', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: DailyOverview) => void;
    const read = vi.fn<OverviewSource['read']>()
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockRejectedValueOnce(new Error('HTTP 503'))
      .mockRejectedValueOnce(new Error('HTTP 503'))
      .mockResolvedValue(parseDailyOverview(today));
    render(<App source={{ kind: 'http', read }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { resolveFirst(parseDailyOverview(today)); });
    expect(within(screen.getByRole('region', { name: '今日任务' })).getByText(today.tasks[0].title)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toHaveTextContent('正在显示上次成功内容');
    expect(within(screen.getByRole('region', { name: '今日任务' })).getByText(today.tasks[0].title)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(read).toHaveBeenCalledTimes(4);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
