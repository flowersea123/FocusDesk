import { useEffect, useState } from 'react';
import { MAX_TASKS, type DailyOverview, type Task } from '../../contracts/daily-overview';
import { isDeviceTaskTitle, type TaskUpdateRequest } from '../../contracts/task-update';
import { OverviewRequestError } from './data/overview-source';
import './editor.css';

interface Props {
  overview: DailyOverview;
  saving: boolean;
  onSave(input: TaskUpdateRequest): Promise<DailyOverview>;
  onDraftChange?(tasks: Task[] | null): void;
}

export default function TaskEditor({ overview, saving, onSave, onDraftChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Task[]>([]);
  const [base, setBase] = useState({ revision: '', tasks: '' });
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [removed, setRemoved] = useState(false);
  useEffect(() => { onDraftChange?.(editing ? draft : null); }, [editing, draft, onDraftChange]);
  useEffect(() => () => onDraftChange?.(null), [onDraftChange]);
  const loadDraft = () => {
    setDraft(structuredClone(overview.tasks));
    setBase({ revision: overview.revision, tasks: JSON.stringify(overview.tasks) });
    setFailure(null); setConflict(false); setSaved(false); setRemoved(false);
  };
  const invalid = draft.some(task => !isDeviceTaskTitle(task.title));
  const dirty = JSON.stringify(draft) !== base.tasks;
  async function submit() {
    if (saving || invalid || !dirty || conflict) return;
    setFailure(null); setSaved(false);
    try {
      await onSave({ revision: base.revision, tasks: structuredClone(draft) });
      setEditing(false); setSaved(true);
    } catch (error) {
      const stale = error instanceof OverviewRequestError && error.status === 409;
      setConflict(stale);
      setFailure(stale ? '任务已在别处修改，草稿已保留。请核对最新任务后重新编辑。' :
        error instanceof Error ? error.message : '保存失败，草稿已保留。');
    }
  }
  return <div className="task-editor">
    {!editing ? <div className="edit-entry">
      <button type="button" className="editor-button" onClick={() => { loadDraft(); setEditing(true); }}>编辑任务</button>
      {saved && <span role="status">已保存，设备将在后续读取时更新。</span>}
    </div> : <section aria-label="任务编辑" className="editor-panel">
      <div className="editor-heading"><strong>编辑任务</strong><span>英文标题 · 最多 {MAX_TASKS} 项 · 保存后生效</span></div>
      {draft.map((task, index) => <div className="editor-row" key={task.id}>
        <input type="checkbox" aria-label={`任务 ${index + 1} 已完成`} checked={task.status === 'done'} disabled={saving}
          onChange={event => setDraft(tasks => tasks.map(item => item.id === task.id ? { ...item, status: event.target.checked ? 'done' : 'todo' } : item))} />
        <input aria-label={`任务 ${index + 1} 标题`} value={task.title} maxLength={40} disabled={saving}
          aria-invalid={!isDeviceTaskTitle(task.title)} placeholder="Write an English task"
          onChange={event => setDraft(tasks => tasks.map(item => item.id === task.id ? { ...item, title: event.target.value } : item))} />
        <button type="button" className="editor-remove" aria-label={`移除任务 ${index + 1}`} disabled={saving}
          onClick={() => { setDraft(tasks => tasks.filter(item => item.id !== task.id)); setRemoved(true); }}>移除</button>
      </div>)}
      {!draft.length && <p className="editor-hint">暂无任务，可以添加新任务；保存空列表将清空当前任务。</p>}
      <button type="button" className="editor-add" disabled={saving || draft.length >= MAX_TASKS}
        onClick={() => setDraft(tasks => [...tasks, {
          id: globalThis.crypto?.randomUUID?.() ?? `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          title: '', status: 'todo', due_at: null,
        }])}>添加任务</button>
      {invalid && <p className="editor-hint">标题需包含 1–40 个可打印英文字符，不能全为空格。</p>}
      {draft.length >= MAX_TASKS && <p className="editor-hint">已达任务上限 {MAX_TASKS} 项，可编辑或移除已有任务。</p>}
      {removed && <p className="editor-hint">移除操作仅在点击“保存更改”后提交；取消可恢复。</p>}
      {failure && <div className="editor-error" role="alert"><p>{failure}</p>{conflict &&
        <button type="button" disabled={saving} onClick={loadDraft}>放弃草稿，载入最新任务</button>}</div>}
      <div className="editor-actions">
        <button type="button" className="editor-primary" onClick={() => void submit()} disabled={saving || invalid || !dirty || conflict}>{saving ? '正在保存…' : '保存更改'}</button>
        <button type="button" className="editor-button" disabled={saving} onClick={() => { setEditing(false); setFailure(null); }}>取消编辑</button>
      </div>
    </section>}
  </div>;
}
