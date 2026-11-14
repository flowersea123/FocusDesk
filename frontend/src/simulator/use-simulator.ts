import { useCallback, useEffect, useRef, useState } from 'react';
import type { DisplaySnapshot } from '../../../contracts/display-snapshot';
import { readDisplaySnapshot } from './client';
import { acceptRead, changeConnection, changeMode, failRead, finishDisplay, initialSimulatorState,
  type SimulatorMode, type SimulatorState } from './state';

export type SnapshotReader = (signal: AbortSignal) => Promise<DisplaySnapshot>;

export function useSimulator(paint: (snapshot: DisplaySnapshot) => void, read: SnapshotReader = readDisplaySnapshot) {
  const [state, setState] = useState(() => initialSimulatorState(Date.now()));
  const [busy, setBusy] = useState(false);
  const latest = useRef(state);
  const active = useRef<AbortController | null>(null);
  const alive = useRef(true);

  const commit = useCallback((value: SimulatorState) => { latest.current = value; setState(value); }, []);
  const cancel = useCallback(() => {
    active.current?.abort(); active.current = null;
    setBusy(false);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; active.current?.abort(); active.current = null; };
  }, []);

  const poll = useCallback(async () => {
    if (!alive.current || active.current || !latest.current.online) return;
    const controller = new AbortController();
    active.current = controller; setBusy(true);
    const current = () => alive.current && active.current === controller && !controller.signal.aborted && latest.current.online;
    try {
      const snapshot = await read(controller.signal);
      if (!current()) return;
      const plan = acceptRead(latest.current, snapshot, Date.now());
      let next = plan.state;
      if (plan.frame) {
        try {
          paint(plan.frame);
          next = finishDisplay(next, plan.frame, Date.now());
        } catch (error) {
          next = finishDisplay(next, plan.frame, Date.now(), error instanceof Error ? error.message : '模拟屏绘制失败。');
        }
      }
      commit(next);
    } catch (error) {
      if (current()) commit(failRead(latest.current, error instanceof Error ? error.message : '无法读取 Hub。', Date.now()));
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (alive.current) setBusy(false);
      }
    }
  }, [read, paint, commit]);

  useEffect(() => {
    if (!state.online || busy) return;
    const timer = setTimeout(() => { void poll(); }, Math.max(0, state.nextPollAt - Date.now()));
    return () => clearTimeout(timer);
  }, [state.online, state.nextPollAt, state.mode, busy, poll]);

  const setMode = useCallback((mode: SimulatorMode) => {
    cancel(); commit(changeMode(latest.current, mode, Date.now()));
  }, [cancel, commit]);
  const setOnline = useCallback((online: boolean) => {
    cancel(); commit(changeConnection(latest.current, online, Date.now()));
  }, [cancel, commit]);
  return { state, busy, poll, setMode, setOnline };
}
