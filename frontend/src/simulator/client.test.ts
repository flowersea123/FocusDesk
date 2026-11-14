import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DisplaySnapshot } from '../../../contracts/display-snapshot';
import { readDisplaySnapshot } from './client';

const snapshot: DisplaySnapshot = { schema_version: 'display-1', layout_version: 'goal-1', revision: 'test',
  width: 400, height: 300, commands: [[0, 0, 0, 400, 300, 1]] };
const snapshotBody = JSON.stringify(snapshot);
const bodyLength = new TextEncoder().encode(snapshotBody).byteLength;
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(bodyLength) };
afterEach(() => vi.useRealTimers());

describe('display snapshot HTTP reader', () => {
  it('reads the real same-origin device endpoint and validates the response', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(snapshotBody, { headers }));
    expect(await readDisplaySnapshot(new AbortController().signal, fetcher)).toEqual(snapshot);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/display-snapshot', expect.objectContaining({
      cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' },
    }));
  });

  it.each([
    ['missing', null], ['empty', ''], ['zero', '0'], ['negative', '-1'],
    ['fractional', '1.5'], ['exponent', '1e2'], ['duplicate', '123, 123'], ['oversized', '4097'],
  ])('rejects a %s Content-Length even when the JSON is valid', async (_label, value) => {
    const malformed = new Headers(headers);
    if (value === null) malformed.delete('Content-Length'); else malformed.set('Content-Length', value);
    const response = new Response(snapshotBody, { headers: malformed });
    await expect(readDisplaySnapshot(new AbortController().signal, vi.fn().mockResolvedValue(response))).rejects.toThrow(/Content-Length/);
    expect(response.body!.locked).toBe(false);
  });

  it.each([
    ['Transfer-Encoding', 'chunked'], ['Content-Encoding', 'gzip'],
    ['Content-Encoding', 'br'], ['Content-Encoding', 'identity'], ['Transfer-Encoding', ''],
  ])('rejects %s: %s before a browser-decoded body can appear device-compatible', async (name, value) => {
    const response = new Response(snapshotBody, { headers: { ...headers, [name]: value } });
    await expect(readDisplaySnapshot(new AbortController().signal, vi.fn().mockResolvedValue(response))).rejects.toThrow(/设备不支持/);
  });

  it.each([-1, 1])('rejects a valid JSON body whose declared size differs by %i byte', async difference => {
    const response = new Response(snapshotBody, { headers: { ...headers, 'Content-Length': String(bodyLength + difference) } });
    await expect(readDisplaySnapshot(new AbortController().signal, vi.fn().mockResolvedValue(response))).rejects.toThrow(/长度不一致/);
    expect(response.body!.locked).toBe(false);
  });

  it('rejects HTTP errors, wrong media types, declared or streamed oversize, and invalid UTF-8', async () => {
    const responses = [
      new Response('unavailable', { status: 503 }),
      new Response(snapshotBody, { headers: { ...headers, 'Content-Type': 'text/html' } }),
      new Response(snapshotBody, { headers: { ...headers, 'Content-Length': '5000' } }),
      new Response(' '.repeat(4097), { headers: { ...headers, 'Content-Length': '4096' } }),
      new Response(new Uint8Array([0xc0, 0x80]), { headers: { ...headers, 'Content-Length': '2' } }),
    ];
    for (const response of responses) {
      await expect(readDisplaySnapshot(new AbortController().signal, vi.fn().mockResolvedValue(response))).rejects.toThrow();
    }
    const nonAscii = JSON.stringify({ ...snapshot, commands: [[1, 0, 80, 10, 0, '中文']] });
    await expect(readDisplaySnapshot(new AbortController().signal, vi.fn().mockResolvedValue(new Response(nonAscii, {
      headers: { ...headers, 'Content-Length': String(new TextEncoder().encode(nonAscii).byteLength) },
    })))).rejects.toThrow(/ASCII/);
  });

  it('cancels a stalled body on timeout and releases the stream', async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const result = readDisplaySnapshot(new AbortController().signal, vi.fn().mockResolvedValue(new Response(body, { headers })));
    const rejected = expect(result).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(cancel).toHaveBeenCalled(); expect(body.locked).toBe(false);
  });

  it('does not send a request that was already cancelled', async () => {
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn();
    await expect(readDisplaySnapshot(controller.signal, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
