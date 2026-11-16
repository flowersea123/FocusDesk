import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { parseDailyOverview, MAX_TASKS, type DailyOverview, type Task } from '../../contracts/daily-overview';
import type { TaskUpdateRequest } from '../../contracts/task-update';
import fixture from '../../contracts/fixtures/device-demo.json';
import { OverviewRequestError } from './data/overview-source';
import TaskEditor from './TaskEditor';

const initial = () => parseDailyOverview(fixture);
const button = (name: string) => screen.getByRole('button', { name });
const input = (name = '新任务标题') => screen.getByRole('textbox', { name });
const click = (element: HTMLElement) => act(async () => { fireEvent.click(element); });
const key = (element: HTMLElement, value: string, modifiers: Record<string, unknown> = {}) =>
  act(async () => { fireEvent.keyDown(element, { key: value, ...modifiers }); });
const change = (element: HTMLElement, text: string) => fireEvent.change(element, { target: { value: text } });

function saving(data: DailyOverview) {
  let revision = 0;
  return vi.fn(async (request: TaskUpdateRequest) => ({
    ...data, tasks: request.tasks, revision: 'saved-' + ++revision,
    focus: data.focus && request.tasks.some(task => task.id === data.focus!.task_id && task.status === 'todo') ? data.focus : null,
  }));
}
function focusSecond(data: DailyOverview) {
  return { ...data, tasks: data.tasks.map((task, index) => index === 1 ? { ...task, status: 'todo' as const, due_at: '2026-11-02T04:10:00Z' } : task),
    focus: { task_id: data.tasks[1].id, started_at: '2026-11-02T01:00:00Z', ends_at: '2026-11-02T01:25:00Z' } };
}

describe('task rows', () => {
  it('renames in place, previews edits, and persists completion immediately with stable IDs and due dates', async () => {
    const data = focusSecond(initial()); const save = saving(data); const preview = vi.fn();
    const row = data.tasks[1];
    render(<TaskEditor overview={data} saving={false} onSave={save} onDraftChange={preview} />);
    await click(button('编辑 ' + row.title));
    const title = input('任务标题'); expect(title).toHaveFocus();
    change(title, 'Revised title');
    expect(preview).toHaveBeenLastCalledWith(data.tasks.map(task => task.id === row.id ? { ...row, title: 'Revised title' } : task));
    expect(save).not.toHaveBeenCalled();
    await key(title, 'Enter');
    expect(save.mock.calls[0][0]).toEqual({ revision: data.revision, tasks: data.tasks.map(task => task.id === row.id ? { ...row, title: 'Revised title' } : task) });
    expect(preview).toHaveBeenLastCalledWith(null);
    await click(screen.getByRole('checkbox', { name: 'Revised title 已完成' }));
    expect(save.mock.calls[1][0]).toMatchObject({ revision: 'saved-1' });
    expect(save.mock.calls[1][0].tasks[1]).toEqual({ ...row, title: 'Revised title', status: 'done' });
    expect(screen.getByRole('status')).toHaveTextContent('当前专注计时已结束');
    expect(screen.getByRole('checkbox', { name: 'Revised title 已完成' })).toBeChecked();
  });

  it('inserts after a named row, appends using the list button, and cancels an unsaved title back to its trigger', async () => {
    const data = initial(); const save = saving(data); const user = userEvent.setup();
    render(<TaskEditor overview={data} saving={false} onSave={save} />);
    const first = data.tasks[0]; const afterFirst = () => button('在 ' + first.title + ' 后添加任务');
    await user.click(afterFirst()); expect(input()).toHaveFocus();
    await user.type(input(), 'Adjacent task');
    expect(screen.getAllByRole('listitem')[1]).toContainElement(input());
    await user.click(button('保存'));
    const inserted = save.mock.calls[0][0].tasks[1];
    expect(inserted).toEqual({ id: expect.any(String), title: 'Adjacent task', status: 'todo', due_at: null });
    expect(save.mock.calls[0][0].tasks.map(task => task.id)).toEqual([first.id, inserted.id, ...data.tasks.slice(1).map(task => task.id)]);
    expect(button('编辑 Adjacent task')).toHaveFocus();
    await user.click(button('添加任务')); await user.type(input(), 'Last task{Enter}');
    expect(save.mock.calls[1][0].tasks.at(-1)).toMatchObject({ title: 'Last task', due_at: null });
    await user.click(afterFirst()); change(input(), 'Cancelled addition'); await key(input(), 'Escape');
    expect(save).toHaveBeenCalledTimes(2); expect(afterFirst()).toHaveFocus();
  });

  it('restores a deleted task using its original neighbors, status, deadline and ID on the newest revision', async () => {
    const data = focusSecond(initial()); const save = saving(data);
    const view = render(<TaskEditor overview={data} saving={false} onSave={save} />);
    const deleted = data.tasks[1];
    await click(button('删除 ' + deleted.title));
    expect(save.mock.calls[0][0].tasks).toEqual([data.tasks[0], data.tasks[2]]);
    expect(screen.getByRole('status')).toHaveTextContent('专注计时已结束'); expect(button('撤销删除')).toHaveFocus();
    const other = { ...data.tasks[0], title: 'Renamed in other window' };
    const extra = { ...other, id: 'extra', title: 'Newer task' };
    view.rerender(<TaskEditor overview={{ ...data, revision: 'other-window', focus: null, tasks: [extra, other, data.tasks[2]] }} saving={false} onSave={save} />);
    await click(button('撤销删除'));
    expect(save.mock.calls[1][0]).toEqual({ revision: 'other-window', tasks: [extra, other, deleted, data.tasks[2]] });
    expect(button('编辑 ' + deleted.title)).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('原专注计时已结束'); expect(screen.queryByRole('button', { name: '撤销删除' })).toBeNull();
  });

  it('marks an explicit undo of a mail task so the calendar can restore the original item', async () => {
    const data = initial();
    data.tasks[0] = { ...data.tasks[0], id: 'src-' + 'a'.repeat(43) };
    const task = data.tasks[0], save = saving(data);
    render(<TaskEditor overview={data} saving={false} onSave={save}/>);
    await click(button('删除 ' + task.title));
    await click(button('撤销删除'));
    expect(save.mock.calls[0][0]).not.toHaveProperty('restoreTaskId');
    expect(save.mock.calls[1][0]).toMatchObject({ restoreTaskId: task.id, tasks: data.tasks });
  });

  it('merges unrelated online edits, preserves conflicting text until explicit review, and can recover a removed anchor', async () => {
    const data = initial(); const save = saving(data);
    const view = render(<TaskEditor overview={data} saving={false} onSave={save} />);
    await click(button('编辑 ' + data.tasks[0].title)); change(input('任务标题'), 'My draft');
    const latest = { ...data, revision: 'new-1', tasks: [{ ...data.tasks[0], title: 'Elsewhere' }, ...data.tasks.slice(1)] };
    view.rerender(<TaskEditor overview={latest} saving={false} onSave={save} />);
    expect(input('任务标题')).toHaveValue('My draft'); expect(button('保存')).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Elsewhere');
    await click(button('保留草稿并使用最新版本')); await click(button('保存'));
    expect(save.mock.calls[0][0].revision).toBe('new-1'); expect(save.mock.calls[0][0].tasks[0].title).toBe('My draft');
    await click(button('在 ' + data.tasks[1].title + ' 后添加任务')); change(input(), 'Retained');
    const changed = { ...data, revision: 'new-2', tasks: [latest.tasks[0], data.tasks[2]] };
    view.rerender(<TaskEditor overview={changed} saving={false} onSave={save} />);
    expect(input()).toHaveValue('Retained'); expect(button('保存')).toBeDisabled();
    await click(button('改到列表末尾')); await click(button('保存'));
    expect(save.mock.calls[1][0].tasks.slice(0, 2)).toEqual(changed.tasks);
    expect(save.mock.calls[1][0].tasks.at(-1)?.title).toBe('Retained');
  });

  it('retries an interrupted save with the same new ID and prevents repeat writes while awaiting the first reply', async () => {
    const data = initial();
    let complete!: (value: DailyOverview) => void;
    const save = vi.fn<(request: TaskUpdateRequest) => Promise<DailyOverview>>()
      .mockRejectedValueOnce(new Error('网络中断')).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    render(<TaskEditor overview={data} saving={false} onSave={save} />);
    await click(button('添加任务')); change(input(), 'Retry task'); await key(input(), 'Enter');
    expect(screen.getByRole('alert')).toHaveTextContent('网络中断'); expect(input()).toHaveValue('Retry task');
    await click(button('保存')); await key(input(), 'Enter');
    expect(save).toHaveBeenCalledTimes(2); expect(save.mock.calls[0][0]).toEqual(save.mock.calls[1][0]);
    expect(button('取消')).toBeDisabled(); expect(screen.getAllByRole('checkbox')[0]).toBeDisabled();
    await act(async () => { complete({ ...data, revision: 'ok', tasks: save.mock.calls[1][0].tasks }); });
    expect(screen.queryByRole('textbox', { name: '新任务标题' })).toBeNull();
    expect(button('编辑 Retry task')).toHaveFocus();
  });

  it('does not auto-retry a 409 or erase a draft when the first reread has not reached the UI', async () => {
    const data = initial(); const fail = new OverviewRequestError('changed', 409);
    const save = vi.fn<(value: TaskUpdateRequest) => Promise<DailyOverview>>()
      .mockRejectedValueOnce(fail).mockImplementation(async req => ({ ...data, tasks: req.tasks, revision: 'saved' }));
    const view = render(<TaskEditor overview={data} saving={false} onSave={save} />);
    await click(button('编辑 ' + data.tasks[0].title)); change(input('任务标题'), 'Keep text'); await click(button('保存'));
    expect(button('保存')).toBeDisabled(); expect(button('保留草稿并使用最新版本')).toBeDisabled();
    const updated = { ...data, revision: 'new', tasks: data.tasks.map(task => ({ ...task, due_at: '2026-11-02T09:00:00Z' })) };
    view.rerender(<TaskEditor overview={updated} saving={false} onSave={save} />);
    await click(button('保留草稿并使用最新版本')); expect(input('任务标题')).toHaveValue('Keep text');
    await click(button('保存')); expect(save.mock.calls[1][0]).toMatchObject({ revision: 'new' });
    expect(save.mock.calls[1][0].tasks[0].due_at).toBe(updated.tasks[0].due_at);
  });

  it('recognizes a committed creation or removal after a lost response, without duplicating the new task or losing undo', async () => {
    const data = initial();
    const save = vi.fn<(value: TaskUpdateRequest) => Promise<DailyOverview>>().mockRejectedValue(new TypeError('回复中断'));
    const view = render(<TaskEditor overview={data} saving={false} onSave={save} />);
    await click(button('添加任务')); change(input(), 'Actually saved'); await click(button('保存'));
    const afterAdd = { ...data, revision: 'confirmed-add', tasks: save.mock.calls[0][0].tasks };
    view.rerender(<TaskEditor overview={afterAdd} saving={false} onSave={save} />);
    expect(screen.queryByRole('textbox', { name: '新任务标题' })).toBeNull();
    expect(button('编辑 Actually saved')).toBeVisible(); expect(save).toHaveBeenCalledOnce();
    await click(button('删除 Actually saved'));
    const afterDelete = { ...data, revision: 'confirmed-delete', tasks: save.mock.calls[1][0].tasks };
    view.rerender(<TaskEditor overview={afterDelete} saving={false} onSave={save} />);
    expect(button('撤销删除')).toBeEnabled();
    await click(button('撤销删除'));
    expect(save.mock.calls[2][0]).toEqual({ revision: 'confirmed-delete', tasks: afterAdd.tasks });
  });

  it('uses a fresh parent snapshot when another client restores the content and original revision', async () => {
    const data = initial(); const save = saving(data);
    const view = render(<TaskEditor overview={data} saving={false} onSave={save} />);
    await click(button('编辑 ' + data.tasks[0].title)); change(input('任务标题'), 'Brief renamed draft');
    await click(button('保存'));
    expect(button('编辑 Brief renamed draft')).toBeVisible();
    view.rerender(<TaskEditor overview={structuredClone(data)} saving={false} onSave={save} />);
    expect(button('编辑 ' + data.tasks[0].title)).toBeVisible();
    expect(screen.queryByRole('button', { name: '编辑 Brief renamed draft' })).toBeNull();
  });

  it('keeps shortcuts out of text, composition and hidden views, and inserts from the keyboard beside the focused task', async () => {
    const data = initial(); const save = saving(data);
    const area = (active: boolean) => <main id="workspace"><textarea aria-label="other input" />
      <TaskEditor overview={data} saving={false} onSave={save} active={active} /></main>;
    const view = render(area(true)); const trigger = button('编辑 ' + data.tasks[1].title);
    await key(document.body, 'n'); await key(trigger, 'n', { metaKey: true }); await key(trigger, 'Enter', { shiftKey: true, isComposing: true });
    await key(screen.getByRole('textbox', { name: 'other input' }), 'N', { altKey: true, shiftKey: true, code: 'KeyN' });
    expect(screen.queryByRole('textbox', { name: '新任务标题' })).toBeNull();
    trigger.focus(); await key(trigger, 'Enter', { shiftKey: true }); expect(input()).toHaveFocus();
    change(input(), 'IME draft'); await key(input(), 'Enter', { isComposing: true }); expect(save).not.toHaveBeenCalled();
    await key(input(), 'Escape'); expect(trigger).toHaveFocus();
    await key(trigger, 'n'); change(input(), 'Adjacent'); await key(input(), 'Enter');
    expect(save.mock.calls[0][0].tasks[2].title).toBe('Adjacent');
    view.rerender(area(false)); await key(trigger, 'n'); await key(document.body, 'N', { altKey: true, shiftKey: true, code: 'KeyN' });
    expect(screen.queryByRole('textbox', { name: '新任务标题' })).toBeNull();
    view.rerender(area(true)); await key(document.body, 'N', { altKey: true, shiftKey: true, code: 'KeyN' });
    expect(input()).toHaveFocus();
  });

  it('enforces the title and list limits and preserves read-only titles, source flags and selection', async () => {
    const data = initial(); const save = saving(data); const select = vi.fn(); const row = data.tasks[0];
    const view = render(<TaskEditor overview={data} saving={false} onSelect={select} observedId={row.id} selectedId={row.id} />);
    expect(screen.queryByRole('button', { name: '添加任务' })).toBeNull(); expect(screen.queryByRole('checkbox')).toBeNull();
    await click(button('查看 ' + row.title + ' 进度')); expect(select).toHaveBeenCalledWith(row.id);
    expect(within(button('查看 ' + row.title + ' 进度').closest('li')!).getByText('截图识别')).toBeVisible();
    const tasks = Array.from({ length: MAX_TASKS }, (_, i): Task => ({ id: 'row-' + i, title: 'Task ' + i, status: 'todo', due_at: null }));
    view.rerender(<TaskEditor overview={{ ...data, tasks }} saving={false} onSave={save} />);
    expect(button('添加任务')).toBeDisabled(); expect(button('在 Task 0 后添加任务')).toBeDisabled();
    await click(button('编辑 Task 0')); change(input('任务标题'), '中文');
    expect(input('任务标题')).toHaveAttribute('aria-invalid', 'true'); expect(button('保存')).toBeDisabled();
    expect(input('任务标题')).toHaveAttribute('maxLength', '40'); await key(input('任务标题'), 'Escape');
    expect(save).not.toHaveBeenCalled();
  });
});
