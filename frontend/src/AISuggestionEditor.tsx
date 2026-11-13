import { useEffect, useState } from 'react';
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
}

export default function AISuggestionEditor({ overview, saving, writable, onSave, onDraftChange }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const [baseRevision, setBaseRevision] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const value = draft ?? overview.ai_suggestion ?? '';
  const stale = draft !== null && baseRevision !== overview.revision;
  const dirty = draft !== null && draft !== (overview.ai_suggestion ?? '');
  let validation = '';
  try { parseAISuggestionUpdateRequest({ revision: baseRevision || overview.revision, ai_suggestion: value }); }
  catch (error) { validation = error instanceof Error ? error.message : '请检查建议内容。'; }

  useEffect(() => { onDraftChange(draft); }, [draft, onDraftChange]);
  useEffect(() => () => onDraftChange(null), [onDraftChange]);

  function discard() {
    setDraft(null); setBaseRevision(''); setFailure(null); setConflict(false); setSaved(false);
  }

  async function submit() {
    if (!writable || !dirty || saving || validation || stale || conflict) return;
    setFailure(null); setSaved(false);
    try {
      await onSave(parseAISuggestionUpdateRequest({ revision: baseRevision, ai_suggestion: value }));
      setDraft(null); setBaseRevision(''); setSaved(true);
    } catch (error) {
      setConflict(error instanceof OverviewRequestError && error.status === 409);
      setFailure(error instanceof Error ? error.message : '保存失败，草稿已保留。');
    }
  }

  return <section className="ai-suggestion-editor" aria-labelledby="ai-suggestion-title">
    <div className="section-heading"><h2 id="ai-suggestion-title"><label htmlFor="ai-suggestion">AI 建议</label></h2>
      <span className="suggestion-count">{value.length} / {MAX_AI_SUGGESTION_LENGTH}</span></div>
    <textarea id="ai-suggestion" rows={3} value={value} maxLength={MAX_AI_SUGGESTION_LENGTH}
      placeholder="填写或修改希望显示的建议" disabled={saving || !writable} aria-invalid={Boolean(validation)}
      aria-describedby="ai-suggestion-hint" onChange={event => {
        if (draft === null) setBaseRevision(overview.revision);
        setDraft(event.target.value); setFailure(null); setSaved(false);
      }} />
    <p className="field-note" id="ai-suggestion-hint">手动填写，预览最多显示两行。设备显示请使用英文。清空后保存可移除建议。</p>
    {validation && draft !== null && <p className="validation-error">{validation}</p>}
    {(failure || stale || conflict) && <div className="editor-error" role="alert">
      <p>{stale || conflict ? '内容已在别处更新，草稿已保留。请重新载入后修改。' : failure}</p>
      {(stale || conflict) && <button type="button" className="secondary-button" disabled={saving} onClick={discard}>放弃草稿，载入最新建议</button>}
    </div>}
    {writable ? <div className="suggestion-actions">
      <button type="button" className="primary-button" disabled={!dirty || saving || Boolean(validation) || stale || conflict}
        onClick={() => void submit()}>{saving ? '正在保存建议…' : '保存建议'}</button>
      {draft !== null && <button type="button" className="secondary-button" disabled={saving} onClick={discard}>取消修改</button>}
      {saved && <span role="status">AI 建议已保存。</span>}
    </div> : <p className="readonly-note">请在本机打开 FocusDesk 修改 AI 建议。</p>}
  </section>;
}
