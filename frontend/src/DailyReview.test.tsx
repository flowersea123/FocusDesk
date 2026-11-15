import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FocusReview } from '../../contracts/focus-review';
import DailyReview from './DailyReview';

const today = '2026-11-17';
const suggestion = { action: '校对第二页。', evidence: '来自已确认的观察：“完成两页草稿”' };
function result(date = today): FocusReview {
  return { date, today, timezone: 'Asia/Shanghai', trackingSince: '2026-11-16T15:50:00Z', partial: false,
    totalSeconds: 900, sessions: [{ taskId: 'lab', title: 'Finish lab', from: '2026-11-16T16:00:00Z',
      to: '2026-11-16T16:15:00Z', seconds: 900, end: 'expired' }],
    observations: [{ id: 'a', at: '2026-11-16T16:20:00Z', summary: '完成两页草稿' }],
    summary: '当天记录了任务计时和草稿观察。', suggestion, experiment: null, previousExperimentDate: null };
}
afterEach(() => vi.unstubAllGlobals());
describe('DailyReview', () => {
  it('shows timer and observation evidence, saves a checkable experiment and restores it on refresh', async () => {
    const model = result();
    const request = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'PUT') {
        expect(url).toBe('/api/v1/focus-review/experiment');
        expect(JSON.parse(init.body as string)).toEqual({ date: today, plan: suggestion.action, outcome: '第二页已完成。', revision: 'none' });
        model.experiment = { date: today, plan: suggestion.action, outcome: '第二页已完成。', revision: 'saved' };
      }
      return Response.json(model);
    });
    vi.stubGlobal('fetch', request);
    model.observations.push({ id:'b', at:'2026-11-16T16:21:00Z', summary:'屏幕显示批注', source:'automatic' });
    render(<DailyReview refreshKey={1}/>);
    await screen.findByText(model.summary);
    expect(screen.getByText('00:00–00:15')).toBeInTheDocument();
    expect(screen.getByText('完成两页草稿')).toBeInTheDocument();
    expect(screen.getByText('手动确认')).toBeInTheDocument();
    expect(screen.getByText('自动记录')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '用上面的建议填写计划' }));
    fireEvent.change(screen.getByLabelText(/复查结果/), { target: { value: '第二页已完成。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存实验' }));
    await screen.findByText('实验已保存。');
    await waitFor(() => expect(screen.getByLabelText('下一次尝试')).toHaveValue(suggestion.action));
  });

  it('preserves unsaved text on conflicting edits and asks which version to use', async () => {
    const model = result();
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      if (init.method === 'PUT') {
        model.experiment = { date: today, plan: '另一窗口的新版本', outcome: '', revision: 'changed' };
        return Response.json({ error: { message: '已变更' } }, { status: 409 });
      }
      return Response.json(model);
    });
    render(<DailyReview/>);
    const plan = await screen.findByLabelText('下一次尝试');
    fireEvent.change(plan, { target: { value: '我的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '保存实验' }));
    await screen.findByText(/另一窗口的新版本/);
    expect(plan).toHaveValue('我的草稿');
    expect(screen.getByRole('button', { name: '保存实验' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '读取最新记录' }));
    expect(plan).toHaveValue('另一窗口的新版本');
  });

  it('can revisit an earlier unfinished experiment and differentiates load failure from an empty day', async () => {
    let fail = true;
    vi.stubGlobal('fetch', async (url: string) => {
      if (fail) return Response.json({ error: 'local test failure' }, { status: 503 });
      const model = result(url.includes('?') ? '2026-11-16' : today);
      model.previousExperimentDate = model.date === today ? '2026-11-16' : null;
      if (model.date !== today) model.summary = '较早一天的回顾。';
      return Response.json(model);
    });
    render(<DailyReview/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('local test failure');
    expect(screen.queryByRole('button', { name: '保存实验' })).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    fireEvent.click(await screen.findByRole('button', { name: /复查 2026-11-16/ }));
    await screen.findByText('较早一天的回顾。');
    expect(screen.getByLabelText('回顾日期')).toHaveValue('2026-11-16');
  });
});
