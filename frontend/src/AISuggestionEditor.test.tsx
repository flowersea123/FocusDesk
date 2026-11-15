import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { parseDailyOverview, type DailyOverview } from '../../contracts/daily-overview';
import fixture from '../../contracts/fixtures/device-demo.json';
import { OverviewRequestError, type OverviewSource } from './data/overview-source';
import App from './App';

const initial = (): DailyOverview => ({ ...parseDailyOverview(fixture), ai_suggestion: 'Start with the outline.' });

describe('AI suggestion editor', () => {
  it('previews typed suggestions in sample mode and saves only on an explicit click', async () => {
    const user = userEvent.setup();
    const data = initial();
    const updateAISuggestion = vi.fn().mockImplementation(async input => ({ ...data, ...input, revision: 'saved-ai' }));
    const updateTasks = vi.fn();
    render(<App source={{ kind: 'http', read: vi.fn().mockResolvedValue(data), updateAISuggestion, updateTasks }} />);
    const field = await screen.findByRole('textbox', { name: 'AI 建议' });
    expect(field).toHaveValue(data.ai_suggestion);
    expect(field).toHaveAttribute('maxlength', '120');
    await user.click(screen.getByRole('button', { name: '多任务示例' }));
    await user.clear(field);
    await user.type(field, '先完成提纲，再专注 25 分钟。');
    const preview = screen.getByRole('img', { name: '400 × 300 e-paper preview' });
    expect(preview.querySelector('.paper-recommendation p')).toHaveTextContent('先完成提纲，再专注 25 分钟。');
    expect(screen.getByText('未保存草稿')).toBeVisible();
    expect(updateAISuggestion).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '保存建议' }));
    expect(await screen.findByText('AI 建议已保存。')).toBeVisible();
    expect(updateAISuggestion).toHaveBeenCalledExactlyOnceWith({ revision: data.revision, ai_suggestion: '先完成提纲，再专注 25 分钟。' }, expect.any(AbortSignal));
    expect(updateTasks).not.toHaveBeenCalled();
    expect(preview).toHaveAttribute('data-source-revision', 'saved-ai');
    expect(data.ai_suggestion).toBe('Start with the outline.');
  });

  it('cancels a draft and supports explicitly saving an empty suggestion', async () => {
    const user = userEvent.setup(); const data = initial();
    const updateAISuggestion = vi.fn().mockResolvedValue({ ...data, revision: 'cleared-ai', ai_suggestion: '' });
    render(<App source={{ kind: 'http', read: vi.fn().mockResolvedValue(data), updateAISuggestion }} />);
    const field = await screen.findByRole('textbox', { name: 'AI 建议' });
    await user.clear(field);
    expect(document.querySelector('.paper-recommendation p')).toHaveTextContent('No suggestion yet.');
    await user.click(screen.getByRole('button', { name: '取消修改' }));
    expect(field).toHaveValue(data.ai_suggestion);
    expect(updateAISuggestion).not.toHaveBeenCalled();
    await user.clear(field);
    await user.click(screen.getByRole('button', { name: '保存建议' }));
    await screen.findByText('AI 建议已保存。');
    expect(updateAISuggestion.mock.calls[0][0]).toEqual({ revision: data.revision, ai_suggestion: '' });
    expect(field).toHaveValue('');
  });

  it('keeps a failed draft for a manual retry', async () => {
    const user = userEvent.setup(); const data = initial();
    const updateAISuggestion = vi.fn().mockRejectedValueOnce(new Error('Save unavailable'))
      .mockResolvedValueOnce({ ...data, revision: 'retry-ai', ai_suggestion: 'Review the draft.' });
    render(<App source={{ kind: 'http', read: vi.fn().mockResolvedValue(data), updateAISuggestion }} />);
    const field = await screen.findByRole('textbox', { name: 'AI 建议' });
    await user.clear(field); await user.type(field, 'Review the draft.');
    await user.click(screen.getByRole('button', { name: '保存建议' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save unavailable');
    expect(field).toHaveValue('Review the draft.');
    expect(updateAISuggestion).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: '保存建议' }));
    await screen.findByText('AI 建议已保存。');
    expect(updateAISuggestion).toHaveBeenCalledTimes(2);
  });

  it('retains a conflicting draft and loads the latest saved suggestion on request', async () => {
    const user = userEvent.setup(); const data = initial();
    const latest = { ...data, revision: 'other-ai', ai_suggestion: 'Saved elsewhere.' };
    const read = vi.fn().mockResolvedValueOnce(data).mockResolvedValue(latest);
    const updateAISuggestion = vi.fn().mockRejectedValue(new OverviewRequestError('Conflict', 409, 'REVISION_CONFLICT'));
    render(<App source={{ kind: 'http', read, updateAISuggestion }} />);
    const field = await screen.findByRole('textbox', { name: 'AI 建议' });
    await user.clear(field); await user.type(field, 'My draft.');
    await user.click(screen.getByRole('button', { name: '保存建议' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('草稿已保留');
    expect(field).toHaveValue('My draft.');
    expect(screen.getByRole('button', { name: '保存建议' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '放弃草稿，载入最新建议' }));
    expect(field).toHaveValue('Saved elsewhere.');
    expect(updateAISuggestion).toHaveBeenCalledOnce();
  });

  it('disables duplicate writes and focus controls while saving', async () => {
    const user = userEvent.setup(); const data = initial();
    let resolveSave!: (value: DailyOverview) => void;
    const updateAISuggestion = vi.fn().mockImplementation(() => new Promise<DailyOverview>(resolve => { resolveSave = resolve; }));
    render(<App source={{ kind: 'http', read: vi.fn().mockResolvedValue(data), updateAISuggestion, updateFocus: vi.fn() }} />);
    const field = await screen.findByRole('textbox', { name: 'AI 建议' });
    await user.type(field, ' Focus now.');
    await user.click(screen.getByRole('button', { name: '保存建议' }));
    expect(screen.getByRole('button', { name: '正在保存建议…' })).toBeDisabled();
    expect(field).toBeDisabled();
    expect(screen.getByRole('button', { name: '开始专注 · 25 分钟' })).toBeDisabled();
    await act(async () => { resolveSave({ ...data, revision: 'saved-ai', ai_suggestion: 'Start with the outline. Focus now.' }); });
    expect(await screen.findByText('AI 建议已保存。')).toBeVisible();
    expect(updateAISuggestion).toHaveBeenCalledOnce();
  });

  it('shows saved suggestions in read-only views', async () => {
    const data = initial();
    render(<App source={{ kind: 'http', read: vi.fn<OverviewSource['read']>().mockResolvedValue(data) }} />);
    expect(await screen.findByRole('textbox', { name: 'AI 建议' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '保存建议' })).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.paper-recommendation p')).toHaveTextContent(data.ai_suggestion!));
  });
});
