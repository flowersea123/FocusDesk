import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { parseDailyOverview, type DailyOverview } from '../../contracts/daily-overview';
import fixture from '../../contracts/fixtures/device-demo.json';
import { OverviewRequestError, type OverviewSource } from './data/overview-source';
import App from './App';

const initial = (): DailyOverview => ({ ...parseDailyOverview(fixture), ai_suggestion: 'Start with the outline.' });
async function editSuggestion(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '编辑建议' }));
  return screen.getByRole('textbox', { name: 'AI 建议' });
}

describe('AI suggestion editor', () => {
  it('previews typed suggestions in sample mode and saves only on an explicit click', async () => {
    const user = userEvent.setup();
    const data = initial();
    const updateAISuggestion = vi.fn().mockImplementation(async input => ({ ...data, ...input, revision: 'saved-ai' }));
    const updateTasks = vi.fn();
    render(<App source={{ kind: 'http', read: vi.fn().mockResolvedValue(data), updateAISuggestion, updateTasks }} />);
    expect(screen.queryByRole('textbox', { name: 'AI 建议' })).not.toBeInTheDocument();
    const field = await editSuggestion(user);
    expect(field).toHaveValue(data.ai_suggestion);
    expect(field).toHaveFocus();
    expect(screen.queryByText('未保存草稿')).not.toBeInTheDocument();
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
    const field = await editSuggestion(user);
    await user.clear(field);
    expect(document.querySelector('.paper-recommendation p')).toHaveTextContent('No suggestion yet.');
    await user.click(screen.getByRole('button', { name: '取消修改' }));
    expect(screen.queryByRole('textbox', { name: 'AI 建议' })).not.toBeInTheDocument();
    expect(document.querySelector('.paper-recommendation p')).toHaveTextContent(data.ai_suggestion!);
    expect(screen.getByRole('button', { name: '编辑建议' })).toHaveFocus();
    expect(updateAISuggestion).not.toHaveBeenCalled();
    await user.clear(await editSuggestion(user));
    await user.keyboard('{Control>}{Enter}{/Control}');
    await screen.findByText('AI 建议已保存。');
    expect(updateAISuggestion.mock.calls[0][0]).toEqual({ revision: data.revision, ai_suggestion: '' });
    expect(screen.getByRole('button', { name: '添加建议' })).toHaveFocus();
  });

  it('keeps a failed draft for a manual retry', async () => {
    const user = userEvent.setup(); const data = initial();
    const updateAISuggestion = vi.fn().mockRejectedValueOnce(new Error('Save unavailable'))
      .mockResolvedValueOnce({ ...data, revision: 'retry-ai', ai_suggestion: 'Review the draft.' });
    render(<App source={{ kind: 'http', read: vi.fn().mockResolvedValue(data), updateAISuggestion }} />);
    const field = await editSuggestion(user);
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
    const field = await editSuggestion(user);
    await user.clear(field); await user.type(field, 'My draft.');
    await user.click(screen.getByRole('button', { name: '保存建议' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('草稿已保留');
    expect(field).toHaveValue('My draft.');
    expect(screen.getByRole('button', { name: '保存建议' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '放弃草稿，载入最新建议' }));
    expect(await editSuggestion(user)).toHaveValue('Saved elsewhere.');
    expect(updateAISuggestion).toHaveBeenCalledOnce();
  });

  it('can retry a failed conflict refresh from the draft, then explicitly open the updated suggestion', async () => {
    const user = userEvent.setup();
    const data = initial();
    const latest = { ...data, revision:'newer', ai_suggestion:'Revised on the Hub.' };
    const read = vi.fn().mockResolvedValueOnce(data).mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(latest);
    const updateAISuggestion = vi.fn().mockRejectedValue(new OverviewRequestError('Conflict',409,'REVISION_CONFLICT'));
    render(<App source={{kind:'http', read, updateAISuggestion}} />);
    const field = await editSuggestion(user);
    await user.clear(field); await user.type(field,'Keep this draft.');
    await user.click(screen.getByRole('button', {name:'保存建议'}));
    await user.click(await screen.findByRole('button', {name:'重新读取最新建议'}));
    expect(field).toHaveValue('Keep this draft.');
    await user.click(await screen.findByRole('button', {name:'放弃草稿，载入最新建议'}));
    expect(await editSuggestion(user)).toHaveValue(latest.ai_suggestion);
    expect(updateAISuggestion).toHaveBeenCalledOnce();
  });

  it('disables duplicate writes and focus controls while saving', async () => {
    const user = userEvent.setup(); const data = initial();
    let resolveSave!: (value: DailyOverview) => void;
    const updateAISuggestion = vi.fn().mockImplementation(() => new Promise<DailyOverview>(resolve => { resolveSave = resolve; }));
    render(<App source={{ kind: 'http', read: vi.fn().mockResolvedValue(data), updateAISuggestion, updateFocus: vi.fn() }} />);
    const field = await editSuggestion(user);
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
    const section = await screen.findByRole('region', { name: 'AI 建议' });
    expect(within(section).getByText(data.ai_suggestion!)).toBeVisible();
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存建议' })).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.paper-recommendation p')).toHaveTextContent(data.ai_suggestion!));
  });

  it('adds a multiline suggestion, ignores composition shortcuts, and restores focus after Escape and Command+Enter', async () => {
    const user = userEvent.setup();
    const data = { ...initial(), ai_suggestion:'' };
    const updateAISuggestion = vi.fn().mockImplementation(async input => ({ ...data, ...input, revision:'new-ai' }));
    render(<App source={{kind:'http', read:vi.fn().mockResolvedValue(data), updateAISuggestion}} />);
    const add = await screen.findByRole('button', {name:'添加建议'});
    await user.click(add);
    const field = screen.getByRole('textbox', {name:'AI 建议'});
    await user.type(field, 'One{Enter}Two');
    expect(field).toHaveValue('One\nTwo');
    fireEvent.keyDown(field, {key:'Enter', ctrlKey:true, isComposing:true});
    fireEvent.keyDown(field, {key:'Escape', keyCode:229});
    expect(updateAISuggestion).not.toHaveBeenCalled();
    expect(field).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', {name:'添加建议'})).toHaveFocus();
    expect(updateAISuggestion).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', {name:'添加建议'}));
    await user.type(screen.getByRole('textbox', {name:'AI 建议'}), 'Next{Enter}step');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(await screen.findByRole('button', {name:'编辑建议'})).toHaveFocus();
    expect(updateAISuggestion).toHaveBeenCalledExactlyOnceWith({revision:data.revision, ai_suggestion:'Next\nstep'},expect.any(AbortSignal));
  });
});
