import { useRef, useState } from 'react';
import { MAX_ACCOMPLISHMENT_LENGTH, validAccomplishment, type ProjectStatus } from '../../contracts/project-progress';

export type SaveAccomplishment = (id: string, action: 'add-accomplishment' | 'remove-accomplishment', text: string) => Promise<void>;

export default function TaskAccomplishments({ status, onSave }: { status: ProjectStatus; onSave?: SaveAccomplishment }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const writing = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const entries = status.accomplishments ?? status.completed.map(part => ({
    text: part.split('|')[0].trim(), source: status.automaticParts?.includes(part) ? 'automatic' : 'manual', removable: false,
  }));
  const text = draft?.trim() ?? '';
  const invalid = !!text && !validAccomplishment(text);
  const close = () => {
    setDraft(null);
    setError('');
    requestAnimationFrame(() => addButton.current?.focus());
  };
  async function save(action: 'add-accomplishment' | 'remove-accomplishment', value: string) {
    if (writing.current || !onSave) return;
    writing.current = true;
    setBusy(true);
    setError('');
    try {
      await onSave(status.taskId, action, value);
      if (action === 'add-accomplishment') close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试。');
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  return <div className="task-accomplishments">
    {entries.length > 0 && <>
      <strong>已完成</strong>
      <ol aria-label={status.title + ' 已完成事项'}>{entries.map(entry => <li key={entry.text}>
        <span>{entry.text}</span>{entry.source === 'automatic' && <small>自动记录</small>}
        {entry.removable && onSave && <button type="button" className="accomplishment-remove" disabled={busy}
          aria-label={'移除已完成事项「' + entry.text + '」'} onClick={() => void save('remove-accomplishment',entry.text)}>移除</button>}
      </li>)}</ol>
    </>}
    {onSave && (draft === null ? <button type="button" ref={addButton} className="accomplishment-add"
      onClick={() => {setDraft('');setError('');}} aria-label={status.title + ' · 记录已完成事项'}>＋ 记录已完成事项</button> :
      <div className="accomplishment-input">
        <input autoFocus type="text" aria-label={status.title + ' · 已完成的具体事项'} value={draft}
          disabled={busy} aria-invalid={invalid} placeholder="这项任务中，你已经完成了什么？"
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat) return;
            if (event.key === 'Enter' && text && !invalid) { event.preventDefault(); void save('add-accomplishment',text); }
            if (event.key === 'Escape') close();
          }} />
        <button type="button" disabled={busy || !text || invalid} onClick={() => void save('add-accomplishment',text)}>保存</button>
        <button type="button" disabled={busy} onClick={close}>取消</button>
        {invalid && <small role="alert">每条事项最多 {MAX_ACCOMPLISHMENT_LENGTH} 个字符，不能含控制字符。</small>}
      </div>)}
    {error && <small role="alert">{error}</small>}
  </div>;
}
