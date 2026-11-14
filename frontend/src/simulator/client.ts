import { MAX_SNAPSHOT_BYTES, parseDisplaySnapshotText } from './protocol';
import type { DisplaySnapshot } from '../../../contracts/display-snapshot';

export const SNAPSHOT_ENDPOINT = '/api/v1/display-snapshot';
export async function readDisplaySnapshot(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<DisplaySnapshot> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 5000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelReader = () => { void reader?.cancel().catch(() => undefined); };
  controller.signal.addEventListener('abort', cancelReader);
  try {
    controller.signal.throwIfAborted();
    const response = await fetcher(SNAPSHOT_ENDPOINT, { signal: controller.signal, cache: 'no-store',
      redirect: 'error', headers: { Accept: 'application/json' } });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`Hub 读取失败（HTTP ${response.status}）。`); }
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(response.headers.get('content-type')?.trim() ?? '')) {
      await response.body?.cancel(); throw new Error('Hub 返回的内容类型不是设备支持的 JSON。');
    }
    // Match parseHubHeaders: the ESP32 accepts a fixed, uncompressed body only.
    // Browsers may transparently decode these formats, so reject their headers
    // before a successfully decoded browser response can hide a device failure.
    if (response.headers.has('transfer-encoding') || response.headers.has('content-encoding')) {
      await response.body?.cancel(); throw new Error('设备不支持分块、压缩或其他编码的显示响应。');
    }
    const lengthHeader = response.headers.get('content-length')?.trim() ?? '';
    const declaredLength = Number(lengthHeader);
    if (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > MAX_SNAPSHOT_BYTES) {
      await response.body?.cancel(); throw new Error('显示响应必须声明有效的 Content-Length（1–4096 字节）。');
    }
    if (!response.body) throw new Error('Hub 没有返回显示内容。');
    reader = response.body.getReader();
    // Keep a BOM so JSON parsing rejects it, matching the firmware syntax gate.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let bytes = 0, body = '';
    while (true) {
      controller.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('显示响应超过 4 KiB，已拒绝读取。');
      if (bytes > declaredLength) throw new Error('显示响应的实际长度与声明长度不一致。');
      body += decoder.decode(chunk.value, { stream: true });
    }
    controller.signal.throwIfAborted();
    if (bytes !== declaredLength) throw new Error('显示响应的实际长度与声明长度不一致。');
    body += decoder.decode();
    return parseDisplaySnapshotText(body);
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    if (timedOut) throw new Error('读取超时，请确认本机 Hub 正在运行。');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', cancelReader);
    reader?.releaseLock();
  }
}
