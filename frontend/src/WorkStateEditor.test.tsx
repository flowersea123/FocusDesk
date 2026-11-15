import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDailyOverview, type DailyOverview } from '../../contracts/daily-overview';
import type { WorkSignal } from '../../contracts/work-state';
import fixture from '../../contracts/fixtures/device-demo.json';
import EpaperPreview from './EpaperPreview';
import WorkStateEditor from './WorkStateEditor';

const initial = (): DailyOverview => ({ ...parseDailyOverview(fixture), work_state: { goal: 'Ship the first pilot', current_action: '', next_action: '' }, signals: [] });
const signal: WorkSignal = { id: 'signal-1', content: 'Review the deployment', source: 'Manual', created_at: '2026-11-11T01:00:00.000Z', priority: 'urgent', status: 'active' };
afterEach(() => vi.useRealTimers());

describe('work state editing', () => {
  it('renders signal timestamps in the saved workspace timezone with an explicit zone label', () => {
    const data = { ...initial(), timezone: 'UTC', signals: [signal] };
    const props = { saving: false, writable: true, onSave: vi.fn(), onDraftChange: vi.fn() };
    const view = render(<WorkStateEditor {...props} overview={data} />);
    expect(view.container.querySelector('time')).toHaveTextContent('01:00 UTC');
    view.rerender(<WorkStateEditor {...props} overview={{ ...data, timezone: 'Asia/Shanghai' }} />);
    expect(view.container.querySelector('time')).toHaveTextContent('09:00 Asia/Shanghai');
    expect(view.container.querySelector('time')).toHaveAttribute('datetime', signal.created_at);
  });

  it('acknowledges, ignores, closes, reopens and explicitly removes a signal while preserving goal and tasks', async () => {
    const user = userEvent.setup(); const data = { ...initial(), signals: [signal] };
    const save = vi.fn().mockResolvedValue(data); const preview = vi.fn();
    render(<WorkStateEditor overview={data} saving={false} writable onSave={save} onDraftChange={preview} />);
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(preview.mock.lastCall?.[0].signals[0].status).toBe('acknowledged');
    await user.click(screen.getByRole('button', { name: 'Ignore' }));
    expect(preview.mock.lastCall?.[0].signals[0].status).toBe('ignored');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(preview.mock.lastCall?.[0].signals[0].status).toBe('closed');
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(preview.mock.lastCall?.[0].signals[0].status).toBe('active');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(preview.mock.lastCall?.[0].signals).toEqual([]);
    expect(preview.mock.lastCall?.[0].work_state).toEqual(data.work_state);
    expect(save).not.toHaveBeenCalled();
    expect(data.signals[0].status).toBe('active');
  });

  it('rejects non-ASCII drafts and empty signals, preserves a draft on failure, and retries only on click', async () => {
    const user = userEvent.setup(); const data = initial();
    const save = vi.fn().mockRejectedValueOnce(new Error('Service unavailable')).mockResolvedValueOnce(data);
    render(<WorkStateEditor overview={data} saving={false} writable onSave={save} onDraftChange={vi.fn()} />);
    const goal = screen.getByLabelText('YOUR GOAL');
    await user.clear(goal); await user.type(goal, '中文');
    expect(screen.getByRole('button', { name: 'Save work state' })).toBeDisabled();
    await user.clear(goal); await user.type(goal, 'A valid goal');
    await user.click(screen.getByRole('button', { name: '+ Add signal' }));
    expect(screen.getByRole('button', { name: 'Save work state' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Signal 1' }), 'Read the feedback');
    await user.click(screen.getByRole('button', { name: 'Save work state' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Service unavailable');
    expect(goal).toHaveValue('A valid goal'); expect(save).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Save work state' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  });

  it('makes read-only views non-editable and caps manual records at four', async () => {
    const data = { ...initial(), signals: [signal] }; const save = vi.fn();
    const view = render(<WorkStateEditor overview={data} saving={false} writable={false} onSave={save} onDraftChange={vi.fn()} />);
    expect(screen.getByLabelText('YOUR GOAL')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save work state' })).not.toBeInTheDocument();
    view.rerender(<WorkStateEditor overview={{ ...data, signals: Array.from({ length: 4 }, (_, index) => ({ ...signal, id: `signal-${index}` })) }} saving={false} writable onSave={save} onDraftChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '+ Add signal' })).toBeDisabled();
  });
});

describe('browser preview', () => {
  it('renders workspace task text and an accessible transcript with source metadata', () => {
    const data = { ...initial(), signals: [signal] };
    render(<EpaperPreview overview={data} draft={false} />);
    const preview = screen.getByRole('img', { name: '400 × 300 e-paper preview' });
    expect(preview).toHaveClass('paper-design');
    expect(preview).toHaveAttribute('data-source-revision', data.revision);
    expect(preview).toHaveAttribute('data-width', '400');
    expect(preview).toHaveAttribute('data-height', '300');
    const transcript = document.getElementById('preview-transcript')!;
    expect(transcript).toHaveTextContent('FOCUSDESK');
    for (const task of data.tasks.filter(task => task.status === 'todo')) expect(transcript).toHaveTextContent(task.title);
    for (const task of data.tasks.filter(task => task.status === 'done')) expect(transcript).not.toHaveTextContent(task.title);
    expect(transcript).toHaveTextContent('AI RECOMMENDATION No suggestion yet.');
    expect(within(screen.getByLabelText('电子纸四色')).getByText('红')).toBeInTheDocument();
  });
});
