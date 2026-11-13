// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import today from '../../../contracts/fixtures/today.json';
import { createConfiguredSource, createHttpSource, createMockSource } from './overview-source';

afterEach(() => vi.unstubAllEnvs());

const signal = () => new AbortController().signal;
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('configured source', () => {
  it.each([
    { development: true, override: undefined, expected: 'mock' },
    { development: false, override: undefined, expected: 'http' },
    { development: true, override: 'http', expected: 'http' },
    { development: false, override: 'mock', expected: 'mock' },
  ])('selects $expected for development=$development and explicit override=$override', ({ development, override, expected }) => {
    vi.stubEnv('DEV', development);
    vi.stubEnv('VITE_DATA_SOURCE', override);
    expect(createConfiguredSource().kind).toBe(expected);
  });

  it('uses a same-origin API path for the default production build', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_DATA_SOURCE', undefined);
    vi.stubEnv('VITE_API_BASE_URL', undefined);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(today));
    await createConfiguredSource().read('today', signal());
    expect(fetcher).toHaveBeenCalledWith('/api/v1/daily-overview', expect.objectContaining({ cache: 'no-store' }));
  });
});

describe('fixture adapter', () => {
  it('uses shared fixtures, returns fresh data, and separates empty/completed/next-day states', async () => {
    const source = createMockSource(0);
    const first = await source.read('today', signal());
    expect(first).toEqual(today);
    first.tasks[0].title = 'Changed only in this consumer';
    expect((await source.read('today', signal())).tasks[0].title).toBe(today.tasks[0].title);
    expect((await source.read('empty', signal())).tasks).toEqual([]);
    expect((await source.read('completed', signal())).tasks.every(task => task.status === 'done')).toBe(true);
    expect((await source.read('next-day', signal())).date).not.toBe(today.date);
    await expect(source.read('failure', signal())).rejects.toThrow('模拟');
  });

  it('cancels a pending fixture read', async () => {
    const controller = new AbortController();
    const pending = createMockSource(100).read('today', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('HTTP adapter', () => {
  it('uses the candidate read endpoint without caching and validates a successful response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(today));
    const result = await createHttpSource({ baseUrl: 'http://127.0.0.1:8000/', fetcher }).read('today', signal());
    expect(result).toEqual(today);
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8000/api/v1/daily-overview', expect.objectContaining({ cache: 'no-store', headers: { Accept: 'application/json' } }));
  });

  it('rejects HTTP failures rather than treating them as an empty overview', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', { status: 503 }));
    await expect(createHttpSource({ baseUrl: '', fetcher }).read('today', signal())).rejects.toThrow('503');
  });

  it('rejects invalid JSON and invalid contract fields', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{'))
      .mockResolvedValueOnce(jsonResponse({ ...today, schema_version: '999' }));
    const source = createHttpSource({ baseUrl: '', fetcher });
    await expect(source.read('today', signal())).rejects.toThrow('JSON');
    await expect(source.read('today', signal())).rejects.toThrow('schema_version');
  });

  it('rejects oversized streams and cancels without consuming the remaining body', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4097)); },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    await expect(createHttpSource({ baseUrl: '', fetcher }).read('today', signal())).rejects.toThrow('4 KiB');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects oversized Content-Length before reading the stream', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { headers: { 'content-length': '4097' } }));
    await expect(createHttpSource({ baseUrl: '', fetcher }).read('today', signal())).rejects.toThrow('4 KiB');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects malformed UTF-8 instead of replacing it with a valid-looking title', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([0xff])));
    await expect(createHttpSource({ baseUrl: '', fetcher }).read('today', signal())).rejects.toThrow();
  });

  it('applies the total deadline to an incomplete response body', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    await expect(createHttpSource({ baseUrl: '', fetcher, timeoutMs: 10 }).read('today', signal())).rejects.toThrow('超时');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborts a pending fetch after the total deadline', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    await expect(createHttpSource({ baseUrl: '', fetcher, timeoutMs: 10 }).read('today', signal())).rejects.toThrow('超时');
  });

  it('propagates caller cancellation to an in-flight fetch', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const pending = createHttpSource({ baseUrl: '', fetcher }).read('today', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
