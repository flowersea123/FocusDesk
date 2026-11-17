import { workspaceClock } from './data/workspace-clock';
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { isTaskTitle, MAX_TASKS, type DailyOverview, type Task } from '../../contracts/daily-overview';
import { deviceTaskLabel } from '../../contracts/device-task-label';
import { validCalendarId } from '../../contracts/calendar';
import { isDeviceTaskTitle, type TaskUpdateRequest } from '../../contracts/task-update';
import { OverviewRequestError } from './data/overview-source';
import type { ProjectStatus } from '../../contracts/project-progress';
import TaskAccomplishments, {type SaveAccomplishment} from './TaskAccomplishments';
import './task-list.css';

interface Props {
  overview: DailyOverview;
  saving: boolean;
  onSave?(input: TaskUpdateRequest): Promise<DailyOverview>;
  onDraftChange?(tasks: Task[] | null): void;
  statuses?: ProjectStatus[];
  onAccomplishment?: SaveAccomplishment;
  selectedId?: string;
  observedId?: string;
  manual?: boolean;
  onSelect?(id: string): void;
  active?: boolean;
}
type Draft = {
  kind: 'add' | 'edit'; id: string; text: string; initial: string;
  deviceText: string; initialDeviceText: string; after: string | null; date: string; returnTo: string;
};
type Removed = { task: Task; endedFocus: boolean; previous?: string; next?: string; index: number; date: string };

const undoLimit = 20;
function rememberRemoval(items: Removed[], deletion: Removed) {
  return [...items.filter(item => item.task.id !== deletion.task.id).slice(1 - undoLimit), deletion];
}

const newId = () => globalThis.crypto?.randomUUID?.() ?? `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
function proposed(tasks: Task[], draft: Draft): Task[] {
  const titleFields = { title: draft.text, ...(draft.deviceText ? { device_title: draft.deviceText } : {}) };
  if (draft.kind === 'edit') return tasks.map(task => {
    if (task.id !== draft.id) return task;
    const updated = { ...task, ...titleFields };
    if (!draft.deviceText) delete updated.device_title;
    return updated;
  });
  const at = draft.after ? tasks.findIndex(task => task.id === draft.after) : -1;
  const index = at < 0 ? tasks.length : at + 1;
  return [...tasks.slice(0, index), { id: draft.id, ...titleFields, status: 'todo', due_at: null }, ...tasks.slice(index)];
}

const iconPath = {
  edit: 'M14 5l5 5M4 20l5-1 12-12a2 2 0 0 0 0-3l-1-1a2 2 0 0 0-3 0L5 15z',
  add: 'M12 5v14M5 12h14',
  remove: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 10v8M14 10v8',
};
function TaskIcon({ action }: { action: keyof typeof iconPath }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18"
    fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
    <path d={iconPath[action]} />
  </svg>;
}

export default function TaskEditor({ overview, saving, onSave, onDraftChange, statuses, onAccomplishment, selectedId, observedId, manual, onSelect, active = true }: Props) {
  const formId = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ack, setAck] = useState<{ parent: DailyOverview; value: DailyOverview } | null>(null);
  const [removed, setRemoved] = useState<Removed[]>([]);
  const [unconfirmedRemoval, setUnconfirmedRemoval] = useState<Removed | null>(null);
  const [failedRevision, setFailedRevision] = useState('');
  const [failure, setFailure] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [focusKey, setFocusKey] = useState('');
  const group = useRef<HTMLDivElement>(null);
  const writing = useRef(false);
  const alive = useRef(true);
  // Acknowledged writes are usable immediately, even before the parent delivers its next snapshot.
  const current = ack?.parent === overview ? ack.value : overview;
  const tasks = current.tasks;
  const busy = saving || pending;
  const locked = busy || !!draft;
  const full = tasks.length >= MAX_TASKS;
  const original = draft && tasks.find(task => task.id === draft.id);
  const missingAnchor = !!(draft?.after && !tasks.some(task => task.id === draft.after));
  const changed = !!draft && (draft.date !== current.date ||
    (draft.kind === 'edit' ? original?.title !== draft.initial || (original?.device_title ?? '') !== draft.initialDeviceText : !!original || missingAnchor));
  const conflict = !!draft && (changed || !!failedRevision);
  const canSave = !!draft && !busy && !conflict && isTaskTitle(draft.text) &&
    (!draft.deviceText || isDeviceTaskTitle(draft.deviceText)) &&
    (draft.kind === 'add' ? !full : draft.text !== draft.initial || draft.deviceText !== draft.initialDeviceText);
  const undo = removed.filter(item => item.date === current.date && !tasks.some(task => task.id === item.task.id)).at(-1);
  useEffect(() => {
    setRemoved(items => {
      const remaining = items.filter(item => item.date === current.date && !tasks.some(task => task.id === item.task.id));
      return remaining.length === items.length ? items : remaining;
    });
  }, [current.date, tasks]);
  // A service may commit before its reply is lost. A later snapshot confirms the same UUID.
  useEffect(() => {
    if (busy || draft?.kind !== 'add' || draft.date !== current.date || !original || original.title !== draft.text ||
      (original.device_title ?? '') !== draft.deviceText) return;
    setDraft(null); setFailedRevision(''); setFailure(''); setMessage('任务已添加。'); setFocusKey('edit:' + original.id);
  }, [busy, draft, current.date, original]);
  useEffect(() => {
    if (!unconfirmedRemoval || busy) return;
    if (unconfirmedRemoval.date !== current.date) { setUnconfirmedRemoval(null); return; }
    if (tasks.some(task => task.id === unconfirmedRemoval.task.id)) return;
    setRemoved(items => rememberRemoval(items, unconfirmedRemoval));
    setUnconfirmedRemoval(null); setFailure('');
    setMessage('最新列表已移除「' + unconfirmedRemoval.task.title + '」。' + (unconfirmedRemoval.endedFocus ? '原专注计时已结束。' : ''));
  }, [busy, current.date, tasks, unconfirmedRemoval]);
  const preview = useMemo(() => draft && !changed ? proposed(tasks, draft) : null, [tasks, draft, changed]);
  useEffect(() => { onDraftChange?.(preview); }, [preview, onDraftChange]);
  useEffect(() => () => onDraftChange?.(null), [onDraftChange]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useLayoutEffect(() => {
    if (!focusKey || busy) return;
    if (active) {
      const focusable = Array.from(group.current?.querySelectorAll<HTMLElement>('[data-task-focus]') ?? []);
      const target = focusable.find(node => node.dataset.taskFocus === focusKey && !node.matches(':disabled')) ??
        focusable.find(node => node.dataset.taskFocus === 'add' && !node.matches(':disabled')) ??
        focusable.find(node => !node.matches(':disabled'));
      target?.focus();
      if (focusKey === 'input' && target instanceof HTMLInputElement && draft?.kind === 'edit') target.select();
    }
    setFocusKey('');
  }, [active, busy, focusKey, draft?.kind]);

  function openDraft(kind: Draft['kind'], task?: Task, trigger = 'add') {
    if (!active || !onSave || locked || writing.current || (kind === 'add' && full)) return;
    const editing = kind === 'edit' ? task : undefined;
    setDraft({ kind, id: editing?.id ?? newId(), text: editing?.title ?? '', initial: editing?.title ?? '',
      deviceText: editing?.device_title ?? '', initialDeviceText: editing?.device_title ?? '',
      after: kind === 'add' ? task?.id ?? null : null, date: current.date, returnTo: trigger });
    setFailure(''); setFailedRevision(''); setMessage(''); setFocusKey('input');
  }

  useEffect(() => {
    if (!active || !onSave || locked || full) return;
    function quickAdd(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"]), input:not([type="checkbox"])')) return;
      const withinList = !!group.current?.contains(target);
      const letter = event.key.toLowerCase() === 'n' || event.code === 'KeyN';
      const workspaceShortcut = event.altKey && event.shiftKey && letter;
      const rowShortcut = withinList && !event.altKey && (event.shiftKey ? event.key === 'Enter' : event.key.toLowerCase() === 'n');
      if (!rowShortcut && !(workspaceShortcut && (withinList || target === document.body || target.closest('#workspace')))) return;
      const row = withinList && target.closest<HTMLElement>('[data-task-id]');
      const task = row ? tasks.find(item => item.id === row.dataset.taskId) : undefined;
      const trigger = withinList ? target.closest<HTMLElement>('[data-task-focus]')?.dataset.taskFocus : undefined;
      event.preventDefault(); openDraft('add', rowShortcut ? task : undefined, trigger ?? 'add');
    }
    document.addEventListener('keydown', quickAdd);
    return () => document.removeEventListener('keydown', quickAdd);
  });

  async function persist(next: Task[], options: { onUncertain?: () => void; restoreTaskId?: string } = {}): Promise<boolean> {
    if (!active || !onSave || busy || writing.current) return false;
    writing.current = true; setPending(true); setFailure(''); setMessage('');
    try {
      const result = await onSave({ revision: current.revision, tasks: next, ...(options.restoreTaskId ? { restoreTaskId: options.restoreTaskId } : {}) });
      if (!alive.current) return false;
      setAck({ parent: overview, value: result });
      return true;
    } catch (error) {
      if (!alive.current) return false;
      if (error instanceof OverviewRequestError && error.status === 409) {
        if (draft) setFailedRevision(current.revision);
        else setFailure('任务已在别处修改，请核对最新列表后重试。');
      } else {
        if (!(error instanceof OverviewRequestError) || error.status >= 500) options.onUncertain?.();
        setFailure(error instanceof Error ? error.message : '保存失败，请重试。');
      }
      return false;
    } finally {
      writing.current = false;
      if (alive.current) setPending(false);
    }
  }
  function finishDraft(key: string) {
    setDraft(null); setFailure(''); setFailedRevision(''); setFocusKey(key);
  }
  async function saveDraft() {
    if (!canSave || !draft) return;
    if (await persist(proposed(tasks, draft))) {
      finishDraft('edit:' + draft.id); setMessage(draft.kind === 'add' ? '任务已添加。' : '任务已保存。');
    }
  }
  function rebaseDraft() {
    if (!draft || busy) return;
    if (original && draft.date === current.date) {
      setDraft({ ...draft, kind: 'edit', initial: original.title, initialDeviceText: original.device_title ?? '',
        text: draft.text === draft.initial ? original.title : draft.text,
        deviceText: draft.deviceText === draft.initialDeviceText ? original.device_title ?? '' : draft.deviceText,
        after: null, returnTo: 'edit:' + original.id });
    } else {
      const keepAnchor = !missingAnchor && draft.date === current.date && draft.kind === 'add';
      setDraft({ ...draft, id: draft.kind === 'add' && !original ? draft.id : newId(), kind: 'add', initial: '', initialDeviceText: '',
        after: keepAnchor ? draft.after : null, date: current.date, returnTo: 'add' });
    }
    setFailure(''); setFailedRevision(''); setFocusKey('input');
  }
  async function toggle(task: Task) {
    if (locked) return;
    const status = task.status === 'done' ? 'todo' : 'done';
    if (await persist(tasks.map(item => item.id === task.id ? { ...item, status } : item))) {
      setMessage(status === 'done' && current.focus?.task_id === task.id ? '已标记完成，当前专注计时已结束。' :
        status === 'done' ? '已标记完成。' : '已恢复待完成。');
      setFocusKey('check:' + task.id);
    }
  }
  async function remove(task: Task) {
    if (locked) return;
    const index = tasks.findIndex(item => item.id === task.id);
    const endedFocus = current.focus?.task_id === task.id;
    const deletion = { task, endedFocus, previous: tasks[index - 1]?.id, next: tasks[index + 1]?.id, index, date: current.date };
    setUnconfirmedRemoval(null);
    if (await persist(tasks.filter(item => item.id !== task.id), { onUncertain: () => setUnconfirmedRemoval(deletion) })) {
      setRemoved(items => rememberRemoval(items, deletion));
      setFocusKey('undo'); setMessage('已删除「' + task.title + '」。' + (endedFocus ? '当前专注计时已结束。' : ''));
    }
  }
  async function restore() {
    if (!undo || locked || full) return;
    const before = tasks.findIndex(item => item.id === undo.previous);
    const after = tasks.findIndex(item => item.id === undo.next);
    const index = before >= 0 ? before + 1 : after >= 0 ? after : Math.min(undo.index, tasks.length);
    const restored = [...tasks.slice(0, index), undo.task, ...tasks.slice(index)];
    if (await persist(restored, validCalendarId(undo.task.id) ? { restoreTaskId: undo.task.id } : {})) {
      setRemoved(items => items.filter(item => item !== undo)); setFocusKey('edit:' + undo.task.id); setMessage('已恢复「' + undo.task.title + '」。' + (undo.endedFocus ? '原专注计时已结束。' : ''));
    }
  }
  const time = workspaceClock(current.timezone);

  function compose() {
    if (!draft) return null;
    const label = draft.kind === 'add' ? '新任务标题' : '任务标题';
    const returnTo = draft.returnTo;
    const invalid = !!draft.text && !isTaskTitle(draft.text);
    const deviceInvalid = !!draft.deviceText && !isDeviceTaskTitle(draft.deviceText);
    const showDeviceTitle = !!draft.initialDeviceText || !!draft.deviceText || (isTaskTitle(draft.text) && !isDeviceTaskTitle(draft.text));
    const autoLabel = showDeviceTitle ? deviceTaskLabel({ id: draft.id, title: draft.text }) : '';
    const titleError = !draft.text.trim() ? '请输入任务名称。' : [...draft.text].length > 40 ?
      '任务名称最多 40 个字符，当前 ' + [...draft.text].length + ' 个。' : '任务名称不能包含换行或控制字符。';
    function draftKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === 'Enter') { event.preventDefault(); void saveDraft(); }
      if (event.key === 'Escape' && !busy) { event.preventDefault(); finishDraft(returnTo); }
    }
    return <div className="task-composer" role="group" aria-label={draft.kind === 'add' ? '添加新任务' : '编辑任务标题'}>
      <input type="text" data-task-focus="input" aria-label={label} aria-invalid={invalid}
        aria-describedby={invalid ? formId + '-title-error' : undefined} placeholder="输入任务名称"
        value={draft.text} disabled={busy} onChange={event => setDraft({ ...draft, text: event.target.value })} onKeyDown={draftKeyDown} />
      <div className="task-compose-actions"><button type="button" className="task-save" disabled={!canSave}
        onClick={() => void saveDraft()}>{draft.kind === 'add' ? '添加任务' : '保存'}</button>
        <button type="button" disabled={busy} onClick={() => finishDraft(draft.returnTo)}>取消</button></div>
      {invalid && <p className="task-form-note" id={formId + '-title-error'}>{titleError}</p>}
      {draft.kind === 'add' && full && <p className="task-form-note">已达 {MAX_TASKS} 项上限，任务草稿已保留。</p>}
      {showDeviceTitle && <details className="task-device-title"><summary>电子屏短标题</summary>
        <input type="text" aria-label="电子屏短标题" value={draft.deviceText} disabled={busy} placeholder={autoLabel}
          aria-invalid={deviceInvalid} aria-describedby={formId + (deviceInvalid ? '-device-error' : '-device-note')}
          onChange={event => setDraft({ ...draft, deviceText: event.target.value })} onKeyDown={draftKeyDown}/>
        <p id={formId + '-device-note'} className="task-form-note">留空时电子屏会显示「{autoLabel}」。</p>
      </details>}
      {deviceInvalid && <p id={formId + '-device-error'} className="task-form-note">
        电子屏短标题限 1–40 个可打印英文字符，留空可使用自动短标题。
      </p>}
      {conflict && <div role="alert" className="task-form-conflict">
        <p>任务列表已变更，草稿已保留。{missingAnchor && '原插入位置已被移除。'}
          {draft.kind === 'edit' && original && original.title !== draft.initial && '当前标题为「' + original.title + '」。'}
          {draft.kind === 'edit' && original && (original.device_title ?? '') !== draft.initialDeviceText &&
            '当前电子屏短标题为「' + deviceTaskLabel(original) + '」。'}</p>
        <button type="button" disabled={busy || (!!failedRevision && failedRevision === current.revision)} onClick={rebaseDraft}>
          {draft.kind === 'edit' && !original ? '另存为新任务' : missingAnchor ? '改到列表末尾' : '保留草稿并使用最新版本'}</button>
      </div>}
    </div>;
  }

  return <div className="task-list-control" ref={group} aria-busy={busy}>
    {tasks.length === 0 && !draft && <p className="desk-empty">今天没有安排的任务</p>}
    <ul className="desk-tasks task-items">{tasks.map(task => {
      const status = statuses?.find(item => item.taskId === task.id);
      const done = task.status === 'done';
      const selected = !!onSelect && selectedId === task.id;
      const editing = draft?.kind === 'edit' && draft.id === task.id;
      return <Fragment key={task.id}><li className={'task-row' + (done ? ' task-done' : '')} data-task-id={task.id} data-selected={selected || undefined}>
        {editing ? compose() : <>
          {onSave ? <label className="task-check-hit" title={current.focus?.task_id === task.id ? '完成此任务会结束当前专注计时' : undefined}><input type="checkbox" aria-label={task.title + ' 已完成'} checked={done} disabled={locked}
            data-task-focus={'check:' + task.id} onChange={() => void toggle(task)} /></label> :
            <span className="desk-task-mark" aria-hidden="true">{done && '✓'}</span>}
          <div className="task-row-main">
            {!onSave && <span className="sr-only">{done ? '已完成，' : '待完成，'}</span>}
            {onSelect ? <button type="button" className="task-title task-progress-select" aria-label={'查看 ' + task.title + ' 详情'}
              data-task-focus={'title:' + task.id} aria-pressed={selected} aria-controls="project-progress" onClick={() => onSelect(task.id)}>{task.title}</button> :
              <span className="task-title">{task.title}</span>}
            <div className="task-row-meta">
              {observedId === task.id && <span className="task-recognized">截图识别</span>}
              {selected && manual && observedId !== task.id && <span className="desk-task-active">正在查看</span>}
              {current.focus?.task_id === task.id && <span className="desk-task-active">专注中</span>}
              {task.due_at && <time className="desk-due" dateTime={task.due_at}>{time.format(new Date(task.due_at))} 截止</time>}
            </div>
          </div>
          {onSave && <div className="task-row-actions">
            <button type="button" disabled={locked} data-task-focus={'edit:' + task.id} aria-label={'编辑 ' + task.title} title="编辑任务"
              onClick={() => openDraft('edit', task, 'edit:' + task.id)}><TaskIcon action="edit" /></button>
            <button type="button" disabled={locked || full} data-task-focus={'add:' + task.id} aria-label={'在 ' + task.title + ' 后添加任务'}
              title="在此任务后添加（Shift + Enter）" onClick={() => openDraft('add', task, 'add:' + task.id)}><TaskIcon action="add" /></button>
            <button type="button" disabled={locked} data-task-focus={'delete:' + task.id} aria-label={'删除 ' + task.title}
              title={current.focus?.task_id === task.id ? '删除此任务会结束当前专注计时' : '删除任务'}
              onClick={() => void remove(task)}><TaskIcon action="remove" /></button>
          </div>}
          {status && <TaskAccomplishments status={status} onSave={onAccomplishment} />}
        </>}
      </li>
      {draft?.kind === 'add' && draft.after === task.id && <li className="task-compose-row">{compose()}</li>}
      </Fragment>;
    })}
      {draft && ((draft.kind === 'add' && (!draft.after || missingAnchor)) || (draft.kind === 'edit' && !original)) &&
        <li className="task-compose-row">{compose()}</li>}
    </ul>
    {onSave && !draft && <div className="task-list-footer">
      <button type="button" className="task-add" data-task-focus="add" disabled={locked || full} aria-label="添加任务"
        aria-keyshortcuts="Alt+Shift+N" title="添加任务（Alt + Shift + N）" onClick={() => openDraft('add')}><span aria-hidden="true">＋</span> 添加任务</button>
      <small className={full ? undefined : 'task-shortcut-note'}>{full ? '已达 ' + MAX_TASKS + ' 项上限' : '任务行内按 Shift + Enter 插入'}</small>
    </div>}
    {onSave && <div className="task-list-notice">
      <span role="status">{pending ? '正在保存…' : message}</span>
      {undo && <button type="button" data-task-focus="undo" disabled={locked || full}
        title={'恢复「' + undo.task.title + '」'} onClick={() => void restore()}>撤销删除</button>}
      {failure && <p role="alert">{failure}</p>}
    </div>}
  </div>;
}
