import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createHash, webcrypto } from 'node:crypto';
import DailySynthesis from './DailySynthesis';
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
afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });
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
    expect(await screen.findByRole('heading',{name:'当日活动时间轴'})).toBeVisible();
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

function reviewDay(date: string): FocusReview {
  const review = result(date);
  review.today = date;
  review.observations = [{ id: 'one', at: date + 'T01:00:00Z', summary: '校对方法章节', source: 'automatic' }];
  review.summary = '最近的屏幕观察记下了“校对方法章节”。';
  return review;
}

function digest(review: FocusReview, summary: string) {
  return { summary, suggestion: '复核引用', used: 1, total: review.observations.length, evidence: [review.observations[0]] };
}

describe('automatic daily synthesis', () => {
  it('shares in-flight generation and finished evidence between views, without a button', async () => {
    const review = reviewDay('2026-11-21');
    let respond!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('crypto', webcrypto);
    const first = render(<DailySynthesis review={review}/>);
    const second = render(<DailySynthesis review={structuredClone(review)}/>);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button')).toBeNull();
    first.unmount();
    const observationRevision = createHash('sha256').update(JSON.stringify([review.date, review.observations])).digest('hex');
    await act(async () => respond(Response.json({ ...digest(review, '自动整理了方法章节。'), observationRevision })));
    expect(await screen.findByText('自动整理了方法章节。')).toBeVisible();
    second.unmount();
    render(<DailySynthesis review={structuredClone(review)}/>);
    expect(screen.getByText('自动整理了方法章节。')).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shows the latest facts immediately and coalesces rapid edits under the same observation ID', async () => {
    vi.useFakeTimers();
    let review = reviewDay('2026-11-22');
    const fetcher = vi.fn(async () => Response.json(digest(review, 'AI 建议' + (review.observations[0].nextStep ?? '写初稿'))));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<DailySynthesis review={review}/>);
    await act(async () => {});
    expect(screen.getByText('AI 建议写初稿')).toBeVisible();
    for (const nextStep of ['核对表格', '完成校对']) {
      review = { ...review, observations: [{ ...review.observations[0], nextStep }] };
      view.rerender(<DailySynthesis review={review}/>);
    }
    expect(screen.queryByText('AI 建议写初稿')).toBeNull();
    expect(screen.getByText(review.summary)).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByText('AI 建议完成校对')).toBeVisible();
  });

  it('never applies a late summary or suggestion to the newly selected date', async () => {
    const previous = reviewDay('2026-11-23');
    const selected = reviewDay('2026-11-24');
    const waiting = new Map<string, (r: Response) => void>();
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => new Promise<Response>(resolve => {
      waiting.set(JSON.parse(String(init.body)).date, resolve);
    }));
    const callback = vi.fn();
    const view = render(<DailySynthesis review={previous} onSuggestion={callback}/>);
    view.rerender(<DailySynthesis review={selected} onSuggestion={callback}/>);
    await act(async () => waiting.get(selected.date)!(Response.json({ ...digest(selected, '当前日期小结'), suggestion: '当前日期计划' })));
    await act(async () => waiting.get(previous.date)!(Response.json({ ...digest(previous, '前一天的小结'), suggestion: '前一天的计划' })));
    expect(screen.getByText('当前日期小结')).toBeVisible();
    expect(screen.queryByText('前一天的小结')).toBeNull();
    expect(callback.mock.calls.filter(([value]) => value).map(([value]) => value.action)).toEqual(['当前日期计划']);
  });

  it('quotes current records while the model is unavailable and retries automatically when active', async () => {
    vi.useFakeTimers();
    const review = reviewDay('2026-11-25');
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(async () => Response.json(digest(review, '模型恢复后的小结')));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<DailySynthesis active={false} review={review}/>);
    expect(fetcher).not.toHaveBeenCalled();
    view.rerender(<DailySynthesis review={{ ...review, observations: [] }}/>);
    expect(fetcher).not.toHaveBeenCalled();
    view.rerender(<DailySynthesis review={review}/>);
    await act(async () => {});
    expect(screen.getByText('暂用当日记录小结，稍后自动重试。')).toBeVisible();
    fireEvent.click(screen.getByText('查看当日记录摘录'));
    expect(screen.getByText('“校对方法章节”')).toBeVisible();
    expect(screen.getByText('09:00')).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByText('模型恢复后的小结')).toBeVisible();
  });

  it('keeps the original cutoff, counts and sources during appends, and displays newly finished inference during recording', async () => {
    vi.useFakeTimers();
    const first = reviewDay('2026-12-01');
    const second = { ...first, observations: [...first.observations,
      { id: 'two', at: first.date + 'T01:10:00Z', summary: '复核表格' }] };
    const third = { ...second, observations: [...second.observations,
      { id: 'three', at: first.date + 'T01:20:00Z', summary: '核对脚注' }] };
    const waiting: ((response: Response) => void)[] = [];
    vi.stubGlobal('fetch', () => new Promise<Response>(resolve => waiting.push(resolve)));
    const callback = vi.fn();
    const view = render(<DailySynthesis review={first} onSuggestion={callback}/>);
    const finish = (review: FocusReview, summary: string) => act(async () => waiting.shift()!(Response.json({
      ...digest(review, summary), used: review.observations.length, evidence: [review.observations.at(-1)],
    })));
    await finish(first, '已整理方法段落。');
    view.rerender(<DailySynthesis review={second} onSuggestion={callback}/>);
    expect(screen.getByText('已整理方法段落。')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('截至 09:00 · 正在自动更新小结');
    expect(screen.getByText(/1 \/ 1 条记录参与生成/)).toBeInTheDocument();
    expect(screen.getByText('“校对方法章节”')).toBeInTheDocument();
    expect(screen.queryByText('“复核表格”')).toBeNull();
    expect(callback.mock.lastCall?.[0].evidence).toContain('截至 09:00');

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    view.rerender(<DailySynthesis review={third} onSuggestion={callback}/>);
    expect(screen.getByText('已整理方法段落。')).toBeVisible();
    await finish(second, '已整理方法和表格。');
    expect(screen.getByText('已整理方法和表格。')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('截至 09:10');
    expect(screen.getByText(/2 \/ 2 条记录参与生成/)).toBeInTheDocument();
    expect(screen.getByText('“复核表格”')).toBeInTheDocument();
    expect(screen.queryByText('“核对脚注”')).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await finish(third, '已整理方法、表格和脚注。');
    expect(screen.getByText('已整理方法、表格和脚注。')).toBeVisible();
    expect(screen.getByText(/3 \/ 3 条记录参与生成/)).toBeInTheDocument();
    expect(screen.queryByText(/截至/)).toBeNull();
  });

  it.each([['edit', '2026-12-02'], ['delete', '2026-12-03'], ['other date', '2026-12-04']])(
    'clears the held summary and suggestion immediately after %s', async (change, date) => {
      vi.useFakeTimers();
      const first = reviewDay(date);
      const old = digest(first, '此前可用的小结');
      const callback = vi.fn();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(old))
        .mockImplementation(async () => new Response(null, { status: 503 })));
      const view = render(<DailySynthesis review={first} onSuggestion={callback}/>);
      await act(async () => {});
      const second = { id: 'two', at: date + 'T02:00:00Z', summary: '阅读实验章节' };
      const third = { id: 'three', at: date + 'T03:00:00Z', summary: '核对图例' };
      const appended = { ...first, observations: [...first.observations, second, third] };
      view.rerender(<DailySynthesis review={appended} onSuggestion={callback}/>);
      expect(screen.getByText(old.summary)).toBeVisible();
      const changed = change === 'edit' ? { ...first, observations: [...first.observations, { ...second, nextStep: '重读说明' }, third] } :
        change === 'delete' ? { ...first, observations: [...first.observations, third] } : reviewDay('2026-12-05');
      view.rerender(<DailySynthesis review={changed} onSuggestion={callback}/>);
      expect(screen.queryByText(old.summary)).toBeNull();
      expect(screen.getByText(changed.summary)).toBeVisible();
      expect(screen.queryByText(/截至/)).toBeNull();
      expect(callback.mock.lastCall?.[0]).toBeNull();
      const next = { ...changed, observations: [...changed.observations, { id: 'four', at: changed.date + 'T04:00:00Z', summary: '检查摘要' }] };
      view.rerender(<DailySynthesis review={next} onSuggestion={callback}/>);
      expect(screen.queryByText(old.summary)).toBeNull();
      await act(async () => {});
    },
  );

  it('rejects a digest from a changed server snapshot even when counts and quoted text still match', async () => {
    const review = reviewDay('2026-11-26');
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('fetch', async () => Response.json({
      ...digest(review, '不属于这个证据版本'), observationRevision: '0'.repeat(64),
    }));
    render(<DailySynthesis review={review}/>);
    expect(await screen.findByText('暂用当日记录小结，稍后自动重试。')).toBeVisible();
    expect(screen.queryByText('不属于这个证据版本')).toBeNull();
  });
});

it('restores an unsaved experiment in the same tab and isolates it from another date', async () => {
  vi.stubGlobal('fetch',async (url:string) => Response.json(result(url.includes('?date=') ? url.split('=')[1] : today)));
  const first = render(<DailyReview/>);
  fireEvent.change(await screen.findByLabelText('下一次尝试'),{target:{value:'复核实验'}});
  fireEvent.change(screen.getByLabelText(/复查结果/),{target:{value:'已复核第一组'}});
  first.unmount();
  render(<DailyReview/>);
  expect(await screen.findByLabelText('下一次尝试')).toHaveValue('复核实验');
  expect(screen.getByLabelText(/复查结果/)).toHaveValue('已复核第一组');
  fireEvent.change(screen.getByLabelText('回顾日期'),{target:{value:'2026-11-16'}});
  await waitFor(() => expect(screen.getByLabelText('下一次尝试')).toHaveValue(''));
  fireEvent.click(screen.getByRole('button',{name:'今天'}));
  await waitFor(() => expect(screen.getByLabelText('下一次尝试')).toHaveValue('复核实验'));
  fireEvent.click(screen.getByRole('button',{name:'放弃草稿'}));
  expect(screen.getByLabelText('下一次尝试')).toHaveValue('');
});
