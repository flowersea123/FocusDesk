import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DailyOverview } from '../../contracts/daily-overview';
import { MAX_TASKS, parseDailyOverview } from '../../contracts/daily-overview';
import fixture from '../../contracts/fixtures/device-demo.json';
import App from './App';
import TaskEditor from './TaskEditor';
import { OverviewRequestError, type OverviewSource } from './data/overview-source';

const initial = () => parseDailyOverview(fixture);
afterEach(() => vi.useRealTimers());

describe('task editor', () => {
  it('stages edit/complete/remove/add and saves one complete request with stable existing IDs', async () => {
    const user = userEvent.setup(); const data = initial();
    const save = vi.fn().mockImplementation(async input => parseDailyOverview({ ...data, ...input, revision: 'saved-version' }));
    render(<TaskEditor overview={data} saving={false} onSave={save} />);
    await user.click(screen.getByRole('button', { name: '编辑任务' }));
    expect(screen.getByRole('button', { name: '添加任务' })).toBeEnabled();
    expect(screen.getByText(`英文标题 · 最多 ${MAX_TASKS} 项 · 保存后生效`)).toBeInTheDocument();
    const title = screen.getByLabelText('任务 1 标题');
    await user.clear(title); await user.type(title, 'Edited task');
    await user.click(screen.getByLabelText('任务 1 已完成'));
    await user.click(screen.getByRole('button', { name: '移除任务 2' }));
    await user.click(screen.getByRole('button', { name: '添加任务' }));
    await user.type(screen.getByLabelText('任务 3 标题'), 'A new task');
    for (let taskNumber = 4; taskNumber <= MAX_TASKS; taskNumber++) {
      await user.click(screen.getByRole('button', { name: '添加任务' }));
      await user.type(screen.getByLabelText(`任务 ${taskNumber} 标题`), `New task ${taskNumber}`);
    }
    expect(screen.getByRole('button', { name: '添加任务' })).toBeDisabled();
    expect(screen.getByText(`已达任务上限 ${MAX_TASKS} 项，可编辑或移除已有任务。`)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '保存更改' }));
    await screen.findByText(/已保存/);
    expect(save).toHaveBeenCalledOnce();
    const request = save.mock.calls[0][0];
    expect(request.revision).toBe(data.revision);
    expect(request.tasks[0]).toEqual({ ...data.tasks[0], title: 'Edited task', status: 'done' });
    expect(request.tasks[1]).toEqual(data.tasks[2]);
    expect(request.tasks[2]).toMatchObject({ title: 'A new task', status: 'todo', due_at: null });
    expect(request.tasks[2].id).toBeTruthy();
    expect(request.tasks).toHaveLength(MAX_TASKS);
    expect(new Set(request.tasks.map((task: {id: string}) => task.id)).size).toBe(MAX_TASKS);
    expect(data.tasks).toEqual(fixture.tasks);
  });

  it('cancel discards a removal and invalid titles cannot be saved', async () => {
    const user = userEvent.setup(); const save = vi.fn();
    render(<TaskEditor overview={initial()} saving={false} onSave={save} />);
    await user.click(screen.getByRole('button', { name: '编辑任务' }));
    expect(screen.getByRole('button', { name: '保存更改' })).toBeDisabled();
    const title = screen.getByLabelText('任务 1 标题');
    expect(title).toHaveAttribute('maxlength', '40');
    await user.clear(title); await user.type(title, '中文');
    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: '保存更改' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '移除任务 1' }));
    await user.click(screen.getByRole('button', { name: '取消编辑' }));
    await user.click(screen.getByRole('button', { name: '编辑任务' }));
    expect(screen.getByLabelText('任务 1 标题')).toHaveValue(fixture.tasks[0].title);
    expect(screen.getByRole('button', { name: '添加任务' })).toBeEnabled();
    expect(save).not.toHaveBeenCalled();
  });

  it('preserves a draft after a save error and only retries on an explicit click', async () => {
    const user = userEvent.setup(); const data = initial();
    const save = vi.fn().mockRejectedValueOnce(new Error('Service unavailable')).mockResolvedValueOnce(data);
    render(<TaskEditor overview={data} saving={false} onSave={save} />);
    await user.click(screen.getByRole('button', { name: '编辑任务' }));
    await user.type(screen.getByLabelText('任务 1 标题'), ' changed');
    await user.click(screen.getByRole('button', { name: '保存更改' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Service unavailable');
    expect(screen.getByLabelText('任务 1 标题')).toHaveValue(data.tasks[0].title + ' changed');
    expect(save).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '保存更改' }));
    await screen.findByText(/已保存/); expect(save).toHaveBeenCalledTimes(2);
  });
});

describe('Dashboard task saves', () => {
  it('previews completion of the focused task with the same focus clearing as a saved update and restores it on cancel', async () => {
    const user = userEvent.setup();
    const data: DailyOverview = { ...initial(), focus: { task_id: fixture.tasks[0].id, started_at: '2026-11-11T01:00:00.000Z', ends_at: '2026-11-11T01:25:00.000Z' } };
    const update = vi.fn();
    render(<App source={{ kind: 'http', read: vi.fn().mockResolvedValue(data), updateTasks: update }} />);
    await user.click(await screen.findByRole('button', { name: '编辑任务' }));
    await user.click(screen.getByLabelText('任务 1 已完成'));
    const tasks = data.tasks.map((task, index) => index === 0 ? { ...task, status: 'done' as const } : task);
    const preview = screen.getByRole('img', { name: '400 × 300 e-paper preview' });
    expect([...preview.querySelectorAll('.preview-task-title')].map(item => item.textContent)).toEqual(tasks.filter(task => task.status === 'todo').map(task => task.title));
    expect(preview).toHaveAttribute('data-source-revision', data.revision);
    expect(screen.getByText('Unsaved preview')).toBeVisible();
    expect(document.getElementById('preview-transcript')).not.toHaveTextContent('FOCUS - UNTIL');
    expect(update).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '取消编辑' }));
    expect([...preview.querySelectorAll('.preview-task-title')].map(item => item.textContent)).toEqual(data.tasks.filter(task => task.status === 'todo').map(task => task.title));
    expect(document.getElementById('preview-transcript')).toHaveTextContent('FOCUS - UNTIL 09:25');
    expect(screen.getByText('Design preview')).toBeVisible();
    expect(update).not.toHaveBeenCalled();
  });

  it('previews removal of the focused task without a focus marker and restores the saved focused snapshot on cancel', async () => {
    const user = userEvent.setup();
    const data: DailyOverview = { ...initial(), focus: { task_id: fixture.tasks[0].id, started_at: '2026-11-11T01:00:00.000Z', ends_at: '2026-11-11T01:25:00.000Z' } };
    const update = vi.fn();
    render(<App source={{ kind: 'http', read: vi.fn().mockResolvedValue(data), updateTasks: update }} />);
    await user.click(await screen.findByRole('button', { name: '编辑任务' }));
    await user.click(screen.getByRole('button', { name: '移除任务 1' }));
    const preview = screen.getByRole('img', { name: '400 × 300 e-paper preview' });
    expect([...preview.querySelectorAll('.preview-task-title')].map(item => item.textContent)).toEqual(data.tasks.slice(1).filter(task => task.status === 'todo').map(task => task.title));
    expect(document.getElementById('preview-transcript')).not.toHaveTextContent('FOCUS - UNTIL');
    expect(screen.getByText('Unsaved preview')).toBeVisible();
    expect(update).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '取消编辑' }));
    expect([...preview.querySelectorAll('.preview-task-title')].map(item => item.textContent)).toEqual(data.tasks.filter(task => task.status === 'todo').map(task => task.title));
    expect(document.getElementById('preview-transcript')).toHaveTextContent('FOCUS - UNTIL 09:25');
    expect(screen.getByText('Design preview')).toBeVisible();
    expect(update).not.toHaveBeenCalled();
  });

  it('holds saving controls and ignores a stale poll result after saving', async () => {
    vi.useFakeTimers();
    const data = initial(); let resolveRead!: (value: DailyOverview) => void;
    let resolveSave!: (value: DailyOverview) => void;
    const read = vi.fn<OverviewSource['read']>().mockResolvedValueOnce(data)
      .mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    const update = vi.fn<NonNullable<OverviewSource['updateTasks']>>().mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; }));
    const source: OverviewSource = { kind: 'http', read, updateTasks: update };
    render(<App source={source} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    fireEvent.click(screen.getByRole('button', { name: '编辑任务' }));
    fireEvent.change(screen.getByLabelText('任务 1 标题'), { target: { value: 'A saved title' } });
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消编辑' })).toBeDisabled();
    expect(read.mock.calls[1][1].aborted).toBe(true);
    const saved = { ...data, revision: 'after-save', tasks: [{ ...data.tasks[0], title: 'A saved title' }, ...data.tasks.slice(1)] };
    await act(async () => { resolveSave(saved); });
    await act(async () => { resolveRead(data); });
    expect(screen.getByRole('region', { name: '今日任务' })).toHaveTextContent('A saved title');
    expect(document.getElementById('preview-transcript')).toHaveTextContent('A saved title');
    expect(screen.queryByText(data.tasks[0].title)).not.toBeInTheDocument();
    expect(update).toHaveBeenCalledOnce();
  });

  it('preserves a conflicting draft, reads latest data, and requires explicit reload before a new save', async () => {
    const user = userEvent.setup(); const data = initial();
    const latest = { ...data, revision: 'other-window', tasks: [{ ...data.tasks[0], title: 'Saved elsewhere' }, ...data.tasks.slice(1)] };
    const read = vi.fn<OverviewSource['read']>().mockResolvedValueOnce(data).mockResolvedValue(latest);
    const update = vi.fn<NonNullable<OverviewSource['updateTasks']>>()
      .mockRejectedValueOnce(new OverviewRequestError('Conflict', 409, 'REVISION_CONFLICT'))
      .mockImplementationOnce(async input => ({ ...latest, ...input, revision: 'finally-saved' }));
    render(<App source={{ kind: 'http', read, updateTasks: update }} />);
    await screen.findAllByText(data.tasks[0].title);
    await user.click(screen.getByRole('button', { name: '编辑任务' }));
    const title = screen.getByLabelText('任务 1 标题'); await user.clear(title); await user.type(title, 'My unsaved draft');
    await user.click(screen.getByRole('button', { name: '保存更改' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('草稿已保留');
    expect(screen.getByLabelText('任务 1 标题')).toHaveValue('My unsaved draft');
    expect(update).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '保存更改' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '放弃草稿，载入最新任务' }));
    expect(screen.getByLabelText('任务 1 标题')).toHaveValue('Saved elsewhere');
    await user.type(screen.getByLabelText('任务 1 标题'), ' now');
    await user.click(screen.getByRole('button', { name: '保存更改' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1][0].revision).toBe('other-window');
  });
});
