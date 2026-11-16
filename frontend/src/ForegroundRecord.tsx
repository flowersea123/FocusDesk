import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecorderStatus } from '../../contracts/foreground-recorder';
import './foreground-record.css';

type Action = 'start' | 'stop' | 'target';
const states = ['idle', 'starting', 'recording', 'stopping', 'error', 'unavailable'];
const validDate = (value: unknown) => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

async function requestStatus(signal: AbortSignal, action?: Action, taskId?: string | null): Promise<RecorderStatus> {
  const response = await fetch('/api/v1/recorder', {
    signal, cache: 'no-store', redirect: 'error',
    ...(action && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...(action === 'target' ? { taskId: taskId ?? null } : action === 'start' && taskId ? { taskId } : {}) }) }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof value?.error === 'string' ? value.error : value?.error?.message || value?.message || '无法连接本机录制服务。');
  }
  if (!value || !states.includes(value.state) || typeof value.message !== 'string' || typeof value.supported !== 'boolean' ||
      (value.targetTaskId != null && typeof value.targetTaskId !== 'string') ||
      (value.observedTaskId != null && typeof value.observedTaskId !== 'string') ||
      (value.observedAt != null && !validDate(value.observedAt)) ||
      !Number.isSafeInteger(value.savedCount) || value.savedCount < 0 || !validDate(value.lastSavedAt) || !validDate(value.sessionStartedAt) ||
      !['darwin', 'win32', 'linux', 'other'].includes(value.platform)) throw new Error('本机服务返回的记录状态无法读取。');
  return value;
}

function failureMessage(cause: unknown) {
  return cause instanceof TypeError ? '无法连接本机录制服务。' : cause instanceof Error ? cause.message : '暂时无法读取记录状态。';
}

export function useForegroundRecorder(enabled: boolean, onRecordsChanged: () => void) {
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState<Action | null>(null);
  const latest = useRef<RecorderStatus | null>(null);
  const reading = useRef<AbortController | null>(null);
  const writing = useRef<AbortController | null>(null);

  const accept = useCallback((value: RecorderStatus) => {
    const previous = latest.current;
    setReadError('');
    if (previous && Object.keys(previous).length === Object.keys(value).length &&
        (Object.keys(value) as (keyof RecorderStatus)[]).every(key => previous[key] === value[key])) return;
    latest.current = value;
    setStatus(value);
    if (previous?.state !== value.state) setActionError('');
    const savesChanged = previous ? previous.lastSavedAt !== value.lastSavedAt || previous.savedCount !== value.savedCount : value.savedCount > 0;
    if (savesChanged) onRecordsChanged();
  }, [onRecordsChanged]);

  const refresh = useCallback(async () => {
    if (!enabled || reading.current || writing.current) return;
    const controller = new AbortController();
    reading.current = controller;
    const timeout = setTimeout(() => controller.abort('timeout'), 8_000);
    try {
      const snapshot = await requestStatus(controller.signal);
      if (!controller.signal.aborted) accept(snapshot);
    } catch (cause) {
      if (controller.signal.reason === 'timeout') setReadError('读取记录状态超时。');
      else if (!controller.signal.aborted) setReadError(failureMessage(cause));
    } finally {
      clearTimeout(timeout);
      if (reading.current === controller) reading.current = null;
    }
  }, [enabled, accept]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await refresh();
      if (!disposed) timer = setTimeout(poll, 2_000);
    }
    const onVisible = () => { if (!document.hidden) void refresh(); };
    void poll();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      reading.current?.abort(); reading.current = null;
      writing.current?.abort(); writing.current = null;
    };
  }, [enabled, refresh]);

  async function change(action: Action, taskId?: string | null) {
    if (!enabled || writing.current) return;
    const controller = new AbortController();
    writing.current = controller;
    // A read started before this click may still carry the old state.
    reading.current?.abort(); reading.current = null;
    setPending(action); setActionError('');
    const timeout = setTimeout(() => controller.abort('timeout'), 60_000);
    try {
      const snapshot = await requestStatus(controller.signal, action, taskId);
      if (!controller.signal.aborted) accept(snapshot);
    } catch (cause) {
      if (controller.signal.reason === 'timeout') setActionError('操作回复超时，请查看最新记录状态。');
      else if (!controller.signal.aborted) setActionError(failureMessage(cause));
    } finally {
      clearTimeout(timeout);
      if (writing.current === controller) {
        writing.current = null;
        setPending(null);
        void refresh();
      }
    }
  }

  return { status, readError, actionError, pending, refresh, change };
}

export type RecorderControls = ReturnType<typeof useForegroundRecorder>;

const stateLabel = {
  idle: '待机', starting: '正在启动', recording: '记录中', stopping: '正在停止', error: '记录异常', unavailable: '当前不可用',
};

export function RecorderButton({ recorder, taskId }: { recorder: RecorderControls; taskId?: string }) {
  const { status, readError, pending } = recorder;
  const state = status?.state;
  const retryRead = !!readError && state !== 'recording' && state !== 'starting';
  const stop = state === 'recording' || state === 'starting' || state === 'stopping';
  const disabled = !!pending || (!retryRead && (state === 'stopping' || !status?.supported || state === 'unavailable'));
  const button = pending === 'start' ? '正在启动…' : pending === 'stop' ? '正在停止…' :
    retryRead ? '重新读取状态' : state === 'stopping' ? '正在停止…' : stop ? '停止记录' : '开始记录';
  return <button type="button" className={'recorder-toggle' + (stop ? ' is-active' : '')} disabled={disabled}
        title={stop ? '停止本次前台画面记录' : '记录当前前台画面，自动更新对应任务的进度'}
        onClick={() => retryRead ? void recorder.refresh() : void recorder.change(stop ? 'stop' : 'start', stop ? undefined : taskId)}>
        <span className="recorder-button-mark" aria-hidden="true" />{button}
    </button>;
}

export function RecorderFeedback({ recorder }: { recorder: RecorderControls }) {
  const { status, readError, actionError } = recorder;
  return <>
    {readError && <p className="recorder-error" role="alert">{readError}</p>}
    {!readError && status?.message && <p className={status.state === 'error' ? 'recorder-error' : 'recorder-note'}
      role={status.state === 'error' ? 'alert' : undefined}>{status.message}</p>}
    {actionError && <p className="recorder-error" role="alert">{actionError}</p>}
  </>;
}

export function RecorderStatusLine({ recorder, timezone }: { recorder: RecorderControls; timezone: string }) {
  const { status, readError } = recorder;
  const state = status?.state;
  const stop = state === 'recording' || state === 'starting' || state === 'stopping';
  const label = readError ? '状态待确认' : state ? stateLabel[state] : '正在读取状态…';
  const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone,
  });

  return <div className="recorder-status" aria-live="polite" aria-atomic="true">
      <span className={'recorder-state' + (state === 'recording' && !readError ? ' is-live' : '')}>
        <i aria-hidden="true" />{label}
      </span>
      {status?.sessionStartedAt && stop && <span>开始于 <time dateTime={status.sessionStartedAt}>{time(status.sessionStartedAt)}</time></span>}
      {status && (stop || status.savedCount > 0) && <span>本次已记 {status.savedCount} 条</span>}
      {status?.lastSavedAt && <span>上次保存 <time dateTime={status.lastSavedAt}>{time(status.lastSavedAt)}</time></span>}
    </div>;
}
