// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import rawFixture from '../../../contracts/fixtures/device-demo.json';
import { parseDailyOverview } from '../../../contracts/daily-overview';
import { createHttpSource, createMockSource, OverviewRequestError } from './overview-source';
import { EMPTY_WORK_STATE } from '../../../contracts/work-state';

const fixture = parseDailyOverview(rawFixture);

describe('task write adapter', () => {
  it('only exposes editing for a same-origin local HTTP service', () => {
    expect(createHttpSource({ baseUrl: '', pageOrigin: 'http://127.0.0.1:8787' }).updateTasks).toBeTypeOf('function');
    expect(createHttpSource({ baseUrl: '', pageOrigin: 'http://192.168.1.10:8787' }).updateTasks).toBeUndefined();
    expect(createHttpSource({ baseUrl: 'http://127.0.0.1:8000', pageOrigin: 'http://127.0.0.1:8787' }).updateTasks).toBeUndefined();
    expect(createMockSource().updateTasks).toBeUndefined();
    expect(createHttpSource({ baseUrl: '', pageOrigin: 'http://127.0.0.1:8787' }).updateFocus).toBeTypeOf('function');
    expect(createHttpSource({ baseUrl: '', pageOrigin: 'http://192.168.1.10:8787' }).updateFocus).toBeUndefined();
    expect(createMockSource().updateFocus).toBeUndefined();
    expect(createHttpSource({ baseUrl: '', pageOrigin: 'http://127.0.0.1:8787' }).updateWorkState).toBeTypeOf('function');
    expect(createHttpSource({ baseUrl: '', pageOrigin: 'http://192.168.1.10:8787' }).updateWorkState).toBeUndefined();
    expect(createHttpSource({ baseUrl: 'http://localhost:8000', pageOrigin: 'http://127.0.0.1:8787' }).updateWorkState).toBeUndefined();
    expect(createMockSource().updateWorkState).toBeUndefined();
    expect(createHttpSource({ baseUrl: '', pageOrigin: 'http://127.0.0.1:8787' }).updateAISuggestion).toBeTypeOf('function');
    expect(createHttpSource({ baseUrl: '', pageOrigin: 'http://192.168.1.10:8787' }).updateAISuggestion).toBeUndefined();
    expect(createHttpSource({ baseUrl: 'http://localhost:8000', pageOrigin: 'http://127.0.0.1:8787' }).updateAISuggestion).toBeUndefined();
    expect(createMockSource().updateAISuggestion).toBeUndefined();
  });

  it('saves and clears the suggestion through its versioned endpoint', async () => {
    const input = { revision: fixture.revision, ai_suggestion: '先完成提纲，再专注 25 分钟。' };
    const saved = { ...fixture, ai_suggestion: input.ai_suggestion };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(saved)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...fixture, ai_suggestion: '' })));
    const source = createHttpSource({ baseUrl: '', pageOrigin: 'http://localhost:8787', fetcher });
    expect(await source.updateAISuggestion!(input, new AbortController().signal)).toEqual(saved);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/daily-overview/ai-suggestion', expect.objectContaining({ method: 'PUT', body: JSON.stringify(input) }));
    expect((await source.updateAISuggestion!({ ...input, ai_suggestion: '' }, new AbortController().signal)).ai_suggestion).toBe('');
  });

  it('sends focus to its versioned endpoint and rejects client-owned duration', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture)));
    const source = createHttpSource({ baseUrl: '', pageOrigin: 'http://localhost:8787', fetcher });
    const input = { revision: fixture.revision, action: 'start' as const, task_id: fixture.tasks[0].id };
    expect(await source.updateFocus!(input, new AbortController().signal)).toEqual(fixture);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/daily-overview/focus', expect.objectContaining({ method: 'PUT', body: JSON.stringify(input) }));
    expect(() => source.updateFocus!({ ...input, duration: 1 } as typeof input, new AbortController().signal)).toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('sends one versioned JSON PUT with Chinese titles and validates the server snapshot', async () => {
    const tasks = [{ ...fixture.tasks[0], title:'看论文', device_title:'Read papers' }, ...fixture.tasks.slice(1)];
    const saved = { ...fixture, tasks };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(saved)));
    const source = createHttpSource({ baseUrl: '', pageOrigin: 'http://127.0.0.1:8787', fetcher });
    const input = { revision: fixture.revision, tasks };
    expect(await source.updateTasks!(input, new AbortController().signal)).toEqual(saved);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/daily-overview/tasks', expect.objectContaining({
      method: 'PUT', body: JSON.stringify(input), headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
    }));
  });

  it('preserves structured conflict status without automatic retry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'REVISION_CONFLICT', message: 'Reload tasks' } }), { status: 409 }));
    const source = createHttpSource({ baseUrl: '', pageOrigin: 'http://127.0.0.1:8787', fetcher });
    await expect(source.updateTasks!({ revision: fixture.revision, tasks: fixture.tasks }, new AbortController().signal))
      .rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT', message: 'Reload tasks' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new OverviewRequestError('test', 409)).toBeInstanceOf(Error);
  });

  it('rejects unsupported titles before issuing a write', () => {
    const fetcher = vi.fn<typeof fetch>();
    const source = createHttpSource({ baseUrl: '', pageOrigin: 'http://localhost:8787', fetcher });
    expect(() => source.updateTasks!({ revision: fixture.revision, tasks: [{ ...fixture.tasks[0], title: '读'.repeat(41) }] }, new AbortController().signal)).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends work state to its versioned endpoint and validates optional fields in the returned overview', async () => {
    const saved = { ...fixture, work_state: { ...EMPTY_WORK_STATE, goal: 'Deliver the pilot' }, signals: [] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(saved)));
    const source = createHttpSource({ baseUrl: '', pageOrigin: 'http://localhost:8787', fetcher });
    const input = { revision: fixture.revision, work_state: saved.work_state, signals: [] };
    expect(await source.updateWorkState!(input, new AbortController().signal)).toEqual(saved);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/daily-overview/work-state', expect.objectContaining({ method: 'PUT', body: JSON.stringify(input) }));
  });

  it('rejects invalid work state without a network request', () => {
    const fetcher = vi.fn<typeof fetch>();
    const source = createHttpSource({ baseUrl: '', pageOrigin: 'http://localhost:8787', fetcher });
    expect(() => source.updateWorkState!({ revision: fixture.revision, work_state: { ...EMPTY_WORK_STATE, goal: '中文' }, signals: [] }, new AbortController().signal)).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves structured work state conflict status without automatic retries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'REVISION_CONFLICT', message: 'Reload the work state' } }), { status: 409 }));
    const source = createHttpSource({ baseUrl: '', pageOrigin: 'http://localhost:8787', fetcher });
    await expect(source.updateWorkState!({ revision: fixture.revision, work_state: EMPTY_WORK_STATE, signals: [] }, new AbortController().signal)).rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
