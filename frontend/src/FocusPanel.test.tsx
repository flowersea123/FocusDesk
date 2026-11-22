import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDailyOverview, type DailyOverview } from '../../contracts/daily-overview';
import raw from '../../contracts/fixtures/device-demo.json';
import App from './App';
import FocusPanel from './FocusPanel';
import { OverviewRequestError, type OverviewSource } from './data/overview-source';

const idle = () => ({ ...parseDailyOverview(raw), focus: null });
const active = (): DailyOverview => ({ ...idle(), revision: 'focus-active', focus: {
  task_id: raw.tasks[0].id, started_at: '2026-11-03T15:50:00.000Z', ends_at: '2026-11-03T16:15:00.000Z',
} });
afterEach(() => vi.useRealTimers());

describe('Focus Mode', () => {
  it('offers only unfinished tasks and submits the selected saved task with revision', async () => {
    const user = userEvent.setup(); const data = idle(); const save = vi.fn().mockResolvedValue(active());
    render(<FocusPanel overview={data} saving={false} onSave={save} />);
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([raw.tasks[0].title, raw.tasks[2].title]);
    await user.selectOptions(screen.getByRole('combobox'), raw.tasks[2].id);
    await user.click(screen.getByRole('button', { name: '开始专注 · 25 分钟' }));
    expect(save).toHaveBeenCalledExactlyOnceWith({ revision: data.revision, action: 'start', task_id: raw.tasks[2].id });
  });

  it('shares the idle selection with the task list and keeps an active session on its original task', async () => {
    const user = userEvent.setup();
    const data = idle();
    const save = vi.fn().mockResolvedValue(active());
    const select = vi.fn();
    const [first, done, second] = data.tasks;
    const panel = (overview: DailyOverview, preferredTaskId: string) => <FocusPanel overview={overview} saving={false}
      preferredTaskId={preferredTaskId} onTaskSelect={select} onSave={save} />;
    const view = render(panel(data, second.id));
    expect(screen.getByRole('combobox', {name:'选择专注任务'})).toHaveValue(second.id);
    await user.selectOptions(screen.getByRole('combobox'), first.id);
    expect(select).toHaveBeenCalledExactlyOnceWith(first.id);
    view.rerender(panel(data, first.id));
    expect(screen.getByRole('combobox')).toHaveValue(first.id);
    view.rerender(panel(active(), second.id));
    expect(screen.getByRole('timer')).toBeVisible();
    expect(screen.getByText(first.title)).toBeVisible();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    view.rerender(panel(data, second.id));
    await user.click(screen.getByRole('button', { name:'开始专注 · 25 分钟' }));
    expect(save).toHaveBeenCalledExactlyOnceWith({revision:data.revision, action:'start', task_id:second.id});
    view.rerender(panel(data, done.id));
    expect(screen.getByRole('combobox')).toHaveValue(first.id);
  });

  it('counts down from the confirmed end time, without focus write controls on a read-only source', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T15:55:30.000Z'));
    render(<FocusPanel overview={active()} saving={false} />);
    expect(screen.getByRole('timer')).toHaveTextContent('19:30');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole('timer')).toHaveTextContent('19:29');
  });

  it('disables start for empty/completed lists and while another write is saving', () => {
    const save = vi.fn(); const data = idle();
    const view = render(<FocusPanel overview={{ ...data, tasks: [] }} saving={false} onSave={save} />);
    expect(screen.getByRole('button')).toBeDisabled();
    view.rerender(<FocusPanel overview={{ ...data, tasks: data.tasks.map(task => ({ ...task, status: 'done' })) }} saving={false} onSave={save} />);
    expect(screen.getByRole('button')).toBeDisabled();
    view.rerender(<FocusPanel overview={data} saving onSave={save} />);
    expect(screen.getByRole('button')).toBeDisabled(); expect(screen.getByRole('combobox')).toBeDisabled();
  });

  it('preserves a failed selection and releases controls without optimistic state changes', async () => {
    const user = userEvent.setup(); const save = vi.fn().mockRejectedValue(new Error('Service unavailable'));
    render(<FocusPanel overview={idle()} saving={false} onSave={save} />);
    await user.selectOptions(screen.getByRole('combobox'), raw.tasks[2].id);
    await user.click(screen.getByRole('button'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Service unavailable');
    expect(screen.getByRole('combobox')).toHaveValue(raw.tasks[2].id);
    expect(screen.getByRole('button')).toBeEnabled(); expect(save).toHaveBeenCalledOnce();
  });

  it('starts/stops from Dashboard and shows the confirmed focus in the browser design preview', async () => {
    const user = userEvent.setup(); const data = idle();
    const save = vi.fn<NonNullable<OverviewSource['updateFocus']>>()
      .mockResolvedValueOnce(active()).mockResolvedValueOnce({ ...data, revision: 'stopped' });
    render(<App source={{ kind: 'http', read: vi.fn().mockResolvedValue(data), updateFocus: save }} />);
    await user.click(await screen.findByRole('button', { name: '开始专注 · 25 分钟' }));
    expect(await screen.findByRole('heading', { name: '正在专注' })).toBeInTheDocument();
    const preview = document.getElementById('preview-transcript')!;
    expect(preview).toHaveTextContent('FOCUS - UNTIL 00:15');
    for (const task of raw.tasks.filter(task => task.status === 'todo')) expect(preview).toHaveTextContent(task.title);
    for (const task of raw.tasks.filter(task => task.status === 'done')) expect(preview).not.toHaveTextContent(task.title);
    expect(preview).toHaveTextContent('AI RECOMMENDATION');
    const design = screen.getByRole('img', { name: '400 × 300 e-paper preview' });
    expect(design).toHaveAttribute('data-source-revision', 'focus-active');
    expect(design.querySelector('.paper-task.is-current .preview-task-title')).toHaveTextContent(raw.tasks[0].title);
    await user.click(screen.getByRole('button', { name: '结束专注' }));
    expect(await screen.findByRole('button', { name: '开始专注 · 25 分钟' })).toBeEnabled();
    expect(save.mock.calls[1][0]).toEqual({ revision: 'focus-active', action: 'stop' });
  });

  it('refreshes a conflict without automatically repeating the start request', async () => {
    const user = userEvent.setup(); const read = vi.fn().mockResolvedValueOnce(idle()).mockResolvedValue(active());
    const save = vi.fn().mockRejectedValue(new OverviewRequestError('Changed elsewhere', 409, 'REVISION_CONFLICT'));
    render(<App source={{ kind: 'http', read, updateFocus: save }} />);
    await user.click(await screen.findByRole('button', { name: '开始专注 · 25 分钟' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Changed elsewhere');
    expect(screen.getByRole('heading', { name: '正在专注' })).toBeInTheDocument();
    expect(save).toHaveBeenCalledOnce();
  });

  it('returns to overview when polling receives expiry, with no timer writes', async () => {
    vi.useFakeTimers(); const save = vi.fn();
    const read = vi.fn().mockResolvedValueOnce(active()).mockResolvedValue(idle());
    render(<App source={{ kind: 'http', read, updateFocus: save }} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('heading', { name: '正在专注' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByRole('button', { name: '开始专注 · 25 分钟' })).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('ignores a delayed overview read after a successful focus start and blocks duplicate clicks', async () => {
    vi.useFakeTimers(); let resolveRead!: (value: DailyOverview) => void;
    let resolveWrite!: (value: DailyOverview) => void;
    const read = vi.fn().mockResolvedValueOnce(idle()).mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    const save = vi.fn().mockImplementationOnce(() => new Promise<DailyOverview>(resolve => { resolveWrite = resolve; }));
    render(<App source={{ kind: 'http', read, updateFocus: save }} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    fireEvent.click(screen.getByRole('button', { name: '开始专注 · 25 分钟' }));
    expect(screen.getByRole('button', { name: '正在更新专注…' })).toBeDisabled();
    expect(read.mock.calls[1][1].aborted).toBe(true);
    await act(async () => { resolveWrite(active()); });
    await act(async () => { resolveRead(idle()); });
    expect(screen.getByRole('heading', { name: '正在专注' })).toBeInTheDocument();
    expect(save).toHaveBeenCalledOnce();
  });
});
