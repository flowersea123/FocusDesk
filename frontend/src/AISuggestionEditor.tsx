import { useEffect, useRef, useState } from 'react';
import type { DailyOverview } from '../../contracts/daily-overview';
import { MAX_AI_SUGGESTION_LENGTH, parseAISuggestionUpdateRequest, type AISuggestionUpdateRequest } from '../../contracts/ai-suggestion';
import { OverviewRequestError } from './data/overview-source';
import './ai-suggestion.css';

interface Props {
  overview: DailyOverview;
  saving: boolean;
  writable: boolean;
  onSave(input: AISuggestionUpdateRequest): Promise<DailyOverview>;
  onDraftChange(value: string | null): void;
  onReload?(): void;
}

export default function AISuggestionEditor({ overview, saving, writable, onSave, onDraftChange, onReload }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [baseRevision, setBaseRevision] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const original = overview.ai_suggestion ?? '';
  const value = draft ?? original;
  const stale = draft !== null && baseRevision !== overview.revision;
  const dirty = draft !== null && draft !== original;
  const locked = saving || pending;
  let validation = '';
  try { parseAISuggestionUpdateRequest({ revision: baseRevision || overview.revision, ai_suggestion: value }); }
  catch (error) { validation = error instanceof Error ? error.message : '请检查建议内容。'; }

  useEffect(() => { onDraftChange(writable && dirty ? draft : null); }, [draft, dirty, writable, onDraftChange]);
  useEffect(() => () => onDraftChange(null), [onDraftChange]);
  useEffect(() => {
    if (!editing && !locked && returnFocus.current) {
      trigger.current?.focus();
      returnFocus.current = false;
    }
  }, [editing, locked]);

  function close(didSave: boolean) {
    returnFocus.current = true;
    setEditing(false); setDraft(null); setBaseRevision(''); setFailure(null); setConflict(false); setSaved(didSave);
  }

  async function submit() {
    if (!writable || !dirty || locked || validation || stale || conflict) return;
    setPending(true); setFailure(null);
    try {
      await onSave(parseAISuggestionUpdateRequest({ revision: baseRevision, ai_suggestion: value }));
      close(true);
    } catch (error) {
      setConflict(error instanceof OverviewRequestError && error.status === 409);
      setFailure(error instanceof Error ? error.message : '保存失败，草稿已保留。');
    } finally {
      setPending(false);
    }
  }

  return <section className="ai-suggestion-editor" aria-labelledby="ai-suggestion-title">
    <div className="section-heading">
      <h2 id="ai-suggestion-title" lang="en">AI Suggestion</h2>
      {editing && writable ? <span className="suggestion-count">{value.length} / {MAX_AI_SUGGESTION_LENGTH}</span> :
        writable && <button type="button" ref={trigger} className="secondary-button" disabled={locked}
          onClick={() => { setEditing(true); setSaved(false); }}>{original ? '编辑建议' : '添加建议'}</button>}
    </div>
    {editing && writable ? <form onSubmit={event => { event.preventDefault(); void submit(); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || locked) return;
        if (event.key === 'Escape') {
          event.preventDefault(); close(false);
        } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          if (!event.repeat) void submit();
        }
      }}>
      <textarea id="ai-suggestion" aria-labelledby="ai-suggestion-title" aria-describedby="ai-suggestion-hint"
        rows={3} autoFocus value={value} maxLength={MAX_AI_SUGGESTION_LENGTH} disabled={locked}
        placeholder="填写希望显示在设备上的建议" aria-invalid={Boolean(validation)} onChange={event => {
          if (draft === null) setBaseRevision(overview.revision);
          setDraft(event.target.value); setFailure(null);
        }} />
      <p className="field-note" id="ai-suggestion-hint">设备最多显示两行英文。清空后保存可移除建议。</p>
      {validation && draft !== null && <p className="validation-error">{validation}</p>}
      {(failure || stale || conflict) && <div className="editor-error" role="alert">
        <p>{stale || conflict ? '内容已在别处更新，草稿已保留。' : failure}</p>
        {stale && <button type="button" className="secondary-button" disabled={locked}
          onClick={() => close(false)}>放弃草稿，载入最新建议</button>}
        {conflict && !stale && (onReload ? <button type="button" className="secondary-button" disabled={locked}
          onClick={onReload}>重新读取最新建议</button> : <p>请在工作台重新读取最新建议。</p>)}
      </div>}
      <div className="suggestion-actions">
        <button type="submit" className="primary-button" disabled={!dirty || locked || Boolean(validation) || stale || conflict}
          aria-keyshortcuts="Control+Enter Meta+Enter">{pending ? '正在保存建议…' : '保存建议'}</button>
        <button type="button" className="secondary-button" disabled={locked} aria-keyshortcuts="Escape" onClick={() => close(false)}>取消修改</button>
        <span className="suggestion-keys">Ctrl / ⌘ + Enter 保存 · Esc 取消</span>
      </div>
    </form> : <>
      {original ? <p className="suggestion-value">{original}</p> : !writable && <p className="suggestion-empty">暂无建议</p>}
      {saved && <p className="suggestion-saved" role="status">AI 建议已保存。</p>}
      {!writable && <p className="readonly-note">请在本机打开 FocusDesk 修改 AI 建议。</p>}
    </>}
  </section>;
}
