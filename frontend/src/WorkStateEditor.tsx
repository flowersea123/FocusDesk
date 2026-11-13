import { useEffect, useState } from 'react';
import type { DailyOverview } from '../../contracts/daily-overview';
import { EMPTY_WORK_STATE, parseWorkStateUpdateRequest, type WorkSignal, type WorkState, type WorkStateUpdateRequest } from '../../contracts/work-state';
import { OverviewRequestError } from './data/overview-source';
import SignalManager from './SignalManager';

export interface WorkDraft { work_state: WorkState; signals: WorkSignal[] }

export default function WorkStateEditor({ overview, saving, writable, onSave, onDraftChange }: {
  overview: DailyOverview;
  saving: boolean;
  writable: boolean;
  onSave(input: WorkStateUpdateRequest): Promise<DailyOverview>;
  onDraftChange(value: WorkDraft | null): void;
}) {
  const [draft, setDraft] = useState<WorkDraft | null>(null);
  const [baseRevision, setBaseRevision] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const value = draft ?? { work_state: overview.work_state ?? EMPTY_WORK_STATE, signals: overview.signals ?? [] };
  const stale = Boolean(draft && baseRevision !== overview.revision);
  let validation = '';
  try { parseWorkStateUpdateRequest({ revision: baseRevision || overview.revision, ...value }); }
  catch (error) { validation = error instanceof Error ? error.message : 'Check the fields before saving.'; }

  useEffect(() => { onDraftChange(draft); }, [draft, onDraftChange]);
  useEffect(() => () => onDraftChange(null), [onDraftChange]);

  function change(patch: Partial<WorkDraft>) {
    if (!draft) setBaseRevision(overview.revision);
    setDraft(structuredClone({ ...value, ...patch }));
    setFailure(null); setSaved(false);
  }
  function discard() {
    setDraft(null); setBaseRevision(''); setFailure(null); setConflict(false); setSaved(false);
  }
  async function submit() {
    if (!draft || saving || validation || stale || conflict) return;
    setFailure(null); setSaved(false);
    try {
      await onSave(parseWorkStateUpdateRequest({ revision: baseRevision, ...draft }));
      setDraft(null); setBaseRevision(''); setSaved(true);
    } catch (error) {
      setConflict(error instanceof OverviewRequestError && error.status === 409);
      setFailure(error instanceof Error ? error.message : 'Could not save. Your draft is retained.');
    }
  }
  return <div className="work-editor">
    <SignalManager signals={value.signals} timezone={overview.timezone} disabled={saving || !writable} onChange={signals => change({ signals })} />
    <section className="work-state-section" aria-labelledby="work-state-title">
      <div className="section-heading"><h2 id="work-state-title">Work state</h2><span className="save-state">{draft ? 'Unsaved draft' : 'Saved work state'}</span></div>
      <div className="goal-field"><label htmlFor="work-goal"><span className="yellow-label">YOUR GOAL</span></label>
        <textarea id="work-goal" rows={2} maxLength={64} disabled={saving || !writable} placeholder="What do you want to move forward?" value={value.work_state.goal}
          onChange={event => change({ work_state: { ...value.work_state, goal: event.target.value } })} />
        <span className="field-note">The outcome that matters today.</span></div>
      <div className="action-fields"><div><label htmlFor="current-action"><span className="filled-diamond" aria-hidden="true">◆</span>CURRENT ACTION</label>
        <input id="current-action" value={value.work_state.current_action} maxLength={64} disabled={saving || !writable} placeholder="Use first unfinished task"
          onChange={event => change({ work_state: { ...value.work_state, current_action: event.target.value } })} /></div>
        <div><label htmlFor="next-action"><span className="outline-diamond" aria-hidden="true">◇</span>NEXT ACTION</label>
          <input id="next-action" value={value.work_state.next_action} maxLength={64} disabled={saving || !writable} placeholder="Use next unfinished task"
            onChange={event => change({ work_state: { ...value.work_state, next_action: event.target.value } })} /></div></div>
      <p className="field-note">English text, up to 64 characters per field. Focus Mode temporarily shows the selected task as your current action.</p>
    </section>
    {writable ? <div className="work-save-area">
      {validation && draft && <p className="validation-error">{validation}</p>}
      {(failure || stale || conflict) && <div className="editor-error" role="alert"><p>{stale || conflict ? 'Saved data changed. Your draft is retained. Load the latest state before editing again.' : failure}</p>
        {(stale || conflict) && <button type="button" disabled={saving} onClick={discard}>Discard draft and load latest</button>}</div>}
      <div className="work-save-actions"><button type="button" className="primary-button" disabled={!draft || saving || Boolean(validation) || stale || conflict} onClick={() => void submit()}>{saving ? 'Saving work state…' : 'Save work state'}</button>
        {draft && <button type="button" className="secondary-button" onClick={discard} disabled={saving}>Discard changes</button>}
        {saved && <span className="save-confirmation" role="status">Saved. The device updates on its next sync.</span>}</div>
    </div> : <p className="readonly-note">Open FocusDesk on this PC to edit. This view is read-only.</p>}
  </div>;
}
