import type { DisplaySnapshot } from '../../../contracts/display-snapshot';

export type SimulatorMode = 'fast' | 'device';
export interface SimulatorState {
  mode: SimulatorMode;
  online: boolean;
  received: DisplaySnapshot | null;
  receivedAt: number | null;
  displayed: DisplaySnapshot | null;
  displayedAt: number | null;
  lastDisplayAttemptAt: number | null;
  screenValid: boolean;
  failures: number;
  nextPollAt: number;
  error: string | null;
  errorPhase: 'read' | 'display' | null;
  result: 'none' | 'drawn' | 'unchanged' | 'deferred' | 'failed';
}

export function initialSimulatorState(now: number): SimulatorState {
  return { mode: 'fast', online: true, received: null, receivedAt: null, displayed: null, displayedAt: null,
    lastDisplayAttemptAt: null, screenValid: false, failures: 0, nextPollAt: now,
    error: null, errorPhase: null, result: 'none' };
}

export function pollInterval(mode: SimulatorMode): number { return mode === 'fast' ? 1000 : 30_000; }
export function guardRemaining(state: SimulatorState, now: number): number {
  return state.mode === 'device' && state.lastDisplayAttemptAt !== null
    ? Math.max(0, state.lastDisplayAttemptAt + 60_000 - now) : 0;
}
export function hasPendingFrame(state: SimulatorState): boolean {
  return Boolean(state.received && (!state.screenValid || state.received.revision !== state.displayed?.revision));
}
export function changeMode(state: SimulatorState, mode: SimulatorMode, now: number): SimulatorState {
  // Switching modes or reconnecting must not reset the last refresh attempt.
  return { ...state, mode, nextPollAt: now };
}
export function changeConnection(state: SimulatorState, online: boolean, now: number): SimulatorState {
  return { ...state, online, nextPollAt: now };
}

/** Like DisplaySync: only a successful read can request a render. A deferred
 * frame waits for the next successful poll; a timer never paints stale data. */
export function acceptRead(state: SimulatorState, snapshot: DisplaySnapshot, now: number): {
  state: SimulatorState; frame: DisplaySnapshot | null;
} {
  if (!state.online) return { state, frame: null };
  const next: SimulatorState = { ...state, received: snapshot, receivedAt: now,
    nextPollAt: now + pollInterval(state.mode) };
  if (state.screenValid && state.displayed?.revision === snapshot.revision) {
    return { state: { ...next, failures: 0, error: null, errorPhase: null, result: 'unchanged' }, frame: null };
  }
  if (guardRemaining(state, now) > 0) {
    return { state: { ...next, result: 'deferred',
      error: state.errorPhase === 'display' ? state.error : null,
      errorPhase: state.errorPhase === 'display' ? 'display' : null }, frame: null };
  }
  return { state: next, frame: snapshot };
}

function failure(state: SimulatorState, message: string, phase: 'read' | 'display', now: number): SimulatorState {
  const delays = [30_000, 60_000, 120_000, 240_000, 300_000];
  const delay = state.mode === 'fast' ? 1000 : delays[Math.min(state.failures, delays.length - 1)];
  return { ...state, failures: Math.min(5, state.failures + 1), nextPollAt: now + delay,
    error: message, errorPhase: phase, result: 'failed' };
}
export function failRead(state: SimulatorState, message: string, now: number): SimulatorState {
  return failure(state, message, 'read', now);
}
export function finishDisplay(state: SimulatorState, snapshot: DisplaySnapshot, now: number, error?: string): SimulatorState {
  const next = { ...state, lastDisplayAttemptAt: now, screenValid: !error };
  if (error) return failure(next, error, 'display', now);
  return { ...next, displayed: snapshot, displayedAt: now, failures: 0, error: null, errorPhase: null,
    nextPollAt: now + pollInterval(state.mode), result: 'drawn' };
}
