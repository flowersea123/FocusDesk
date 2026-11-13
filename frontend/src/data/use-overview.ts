import { useCallback, useEffect, useRef, useState } from 'react';
import type { DailyOverview } from '../../../contracts/daily-overview';
import type { TaskUpdateRequest } from '../../../contracts/task-update';
import type { FocusUpdateRequest } from '../../../contracts/focus-update';
import type { WorkStateUpdateRequest } from '../../../contracts/work-state';
import type { AISuggestionUpdateRequest } from '../../../contracts/ai-suggestion';
import { OverviewRequestError, type DemoScenario, type OverviewSource } from './overview-source';

export function useOverview(source: OverviewSource, scenario: DemoScenario) {
  const [overview, setOverview] = useState<DailyOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRead, setLastRead] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [restart, setRestart] = useState(0);
  const epoch = useRef(0);
  const activeRead = useRef<AbortController | null>(null);
  const activeWrite = useRef<AbortController | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const writing = useRef(false);
  const alive = useRef(true);
  const resumeDelay = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; epoch.current++;
      activeRead.current?.abort(); activeWrite.current?.abort(); clearTimeout(poll.current);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController(); activeRead.current = controller;
    let disposed = false;
    let failures = 0;
    async function read() {
      if (writing.current || disposed) return;
      const generation = epoch.current;
      const current = () => !disposed && alive.current && generation === epoch.current && !writing.current;
      setLoading(true);
      try {
        const value = await source.read(scenario, controller.signal);
        if (!current()) return;
        setOverview(value); setError(null); setLastRead(new Date()); failures = 0;
      } catch (failure) {
        if (!current()) return;
        failures++;
        setError(failure instanceof Error ? failure.message : '暂时无法读取，请重试。');
      } finally {
        if (current()) {
          setLoading(false);
          if (source.kind === 'http') poll.current = setTimeout(read,
            failures ? Math.min(30_000 * 2 ** (failures - 1), 300_000) : 30_000);
        }
      }
    }
    if (resumeDelay.current) {
      const delay = resumeDelay.current; resumeDelay.current = 0;
      poll.current = setTimeout(read, delay);
    } else void read();
    return () => { disposed = true; epoch.current++; controller.abort(); clearTimeout(poll.current); };
  }, [source, scenario, restart]);

  const reload = useCallback(() => {
    if (writing.current) return;
    resumeDelay.current = 0; setRestart(value => value + 1);
  }, []);

  const write = useCallback(async (submit: (signal: AbortSignal) => Promise<DailyOverview>): Promise<DailyOverview> => {
    if (writing.current) throw new Error('任务正在保存，请稍候。');
    writing.current = true; setSaving(true); setLoading(false);
    epoch.current++; activeRead.current?.abort(); clearTimeout(poll.current);
    const controller = new AbortController(); activeWrite.current = controller;
    try {
      const value = await submit(controller.signal);
      if (!alive.current) throw new DOMException('Aborted', 'AbortError');
      setOverview(value); setError(null); setLastRead(new Date()); return value;
    } catch (failure) {
      if (alive.current && failure instanceof OverviewRequestError && failure.status === 409) {
        try {
          const latest = await source.read(scenario, controller.signal);
          if (alive.current) { setOverview(latest); setError(null); setLastRead(new Date()); }
        } catch { /* Retain the draft and conflict if the follow-up read fails. */ }
      }
      throw failure;
    } finally {
      writing.current = false;
      if (alive.current) { setSaving(false); resumeDelay.current = 30_000; setRestart(value => value + 1); }
    }
  }, [source, scenario]);

  const saveTasks = useCallback((input: TaskUpdateRequest) => {
    if (!source.updateTasks) return Promise.reject(new Error('请在本机服务页面编辑任务。'));
    return write(signal => source.updateTasks!(input, signal));
  }, [source, write]);
  const saveFocus = useCallback((input: FocusUpdateRequest) => {
    if (!source.updateFocus) return Promise.reject(new Error('请在本机服务页面开始专注。'));
    return write(signal => source.updateFocus!(input, signal));
  }, [source, write]);

  const saveWorkState = useCallback((input: WorkStateUpdateRequest) => {
    if (!source.updateWorkState) return Promise.reject(new Error('Open FocusDesk on this PC to edit your work state.'));
    return write(signal => source.updateWorkState!(input, signal));
  }, [source, write]);

  const saveAISuggestion = useCallback((input: AISuggestionUpdateRequest) => {
    if (!source.updateAISuggestion) return Promise.reject(new Error('请在本机打开 FocusDesk 编辑 AI 建议。'));
    return write(signal => source.updateAISuggestion!(input, signal));
  }, [source, write]);

  return { overview, loading, error, lastRead, saving, reload, saveTasks, saveFocus, saveWorkState, saveAISuggestion };
}
