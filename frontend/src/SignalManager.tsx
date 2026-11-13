import type { SignalPriority, SignalStatus, WorkSignal } from '../../contracts/work-state';
import { MAX_SIGNALS } from '../../contracts/work-state';

const priorities: { value: SignalPriority; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'action_needed', label: 'Action needed' },
  { value: 'urgent', label: 'Urgent' },
];

export default function SignalManager({ signals, timezone, disabled, onChange }: {
  signals: WorkSignal[];
  timezone: string;
  disabled: boolean;
  onChange(signals: WorkSignal[]): void;
}) {
  function update(id: string, patch: Partial<WorkSignal>) {
    onChange(signals.map(signal => signal.id === id ? { ...signal, ...patch } : signal));
  }
  function add() {
    onChange([...signals, {
      id: globalThis.crypto.randomUUID(), content: '', source: 'Manual',
      created_at: new Date().toISOString(), priority: 'normal', status: 'active',
    }]);
  }
  return <section className="signals-section" aria-labelledby="signals-title">
    <div className="section-heading"><div><p className="eyebrow">AI SIGNAL</p><h2 id="signals-title">Signal management</h2></div>
      <button type="button" className="secondary-button" onClick={add} disabled={disabled || signals.length >= MAX_SIGNALS}>+ Add signal</button>
    </div>
    <p className="field-note">Manually added signals. Connected AI sources have not been enabled.</p>
    {!signals.length && <div className="signal-empty"><span className="signal-idle-mark" aria-hidden="true" /><div><strong>No active signals</strong><p>Add only what deserves your attention.</p></div></div>}
    <div className="signal-list">{signals.map((signal, index) => <article className={`signal-item priority-${signal.priority} status-${signal.status}`} key={signal.id} aria-label={`Signal ${index + 1}`}>
      <div className="signal-topline"><span className={`priority-marker priority-${signal.priority}`} aria-hidden="true" /><label htmlFor={`signal-${signal.id}`}>Signal {index + 1}</label>
        <span className="signal-status">{signal.status.replace('_', ' ')}</span></div>
      <input id={`signal-${signal.id}`} value={signal.content} maxLength={96} disabled={disabled} placeholder="What needs your attention?"
        aria-invalid={!signal.content.trim() || /[^\x20-\x7e]/.test(signal.content)} onChange={event => update(signal.id, { content: event.target.value })} />
      <div className="signal-metadata"><label>Source<input aria-label={`Signal ${index + 1} source`} value={signal.source} maxLength={24} disabled={disabled}
        onChange={event => update(signal.id, { source: event.target.value })} /></label>
        <label>Priority<select aria-label={`Signal ${index + 1} priority`} value={signal.priority} disabled={disabled}
          onChange={event => update(signal.id, { priority: event.target.value as SignalPriority })}>
          {priorities.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select></label></div>
      <div className="signal-bottom"><time dateTime={signal.created_at}>{new Date(signal.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone })} {timezone}</time>
        <div className="signal-actions">{(['acknowledged', 'ignored', 'closed'] as SignalStatus[]).map(status => <button key={status} type="button" disabled={disabled || signal.status === status}
          onClick={() => update(signal.id, { status })}>{status === 'acknowledged' ? 'Acknowledge' : status === 'ignored' ? 'Ignore' : 'Close'}</button>)}
          {signal.status !== 'active' && <button type="button" disabled={disabled} onClick={() => update(signal.id, { status: 'active' })}>Reopen</button>}
          {signal.status === 'closed' && <button type="button" disabled={disabled} onClick={() => onChange(signals.filter(item => item.id !== signal.id))}>Remove</button>}
        </div></div>
    </article>)}</div>
    {signals.length >= MAX_SIGNALS && <p className="field-note">Four signals maximum. Close and remove an old signal to make room.</p>}
  </section>;
}
