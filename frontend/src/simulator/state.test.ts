import { describe, expect, it } from 'vitest';
import type { DisplaySnapshot } from '../../../contracts/display-snapshot';
import { acceptRead, changeConnection, changeMode, failRead, finishDisplay, guardRemaining,
  initialSimulatorState, type SimulatorState } from './state';

const frame = (revision: string): DisplaySnapshot => ({ schema_version: 'display-1', layout_version: 'goal-1',
  revision, width: 400, height: 300, commands: [[0, 0, 0, 400, 300, 1]] });
const first = frame('first'), second = frame('second');
function drawn(mode: 'fast' | 'device' = 'device', finishedAt = 0): SimulatorState {
  const state = changeMode(initialSimulatorState(0), mode, 0);
  return finishDisplay(acceptRead(state, first, 0).state, first, finishedAt);
}

describe('simulator device rhythm', () => {
  it('skips an unchanged displayed revision while recording a new successful read', () => {
    const result = acceptRead(drawn(), first, 30_000);
    expect(result.frame).toBeNull();
    expect(result.state).toMatchObject({ result: 'unchanged', receivedAt: 30_000, displayedAt: 0, nextPollAt: 60_000 });
  });

  it('guards from refresh completion and manual reads cannot bypass the guard', () => {
    let state = drawn('device', 5000);
    for (const time of [30_000, 60_000, 64_999]) {
      const result = acceptRead(state, second, time);
      expect(result.frame).toBeNull();
      expect(result.state.displayed).toEqual(first);
      expect(result.state.received).toEqual(second);
      expect(result.state.result).toBe('deferred');
      state = result.state;
    }
    expect(acceptRead(state, second, 65_000).frame).toEqual(second);
  });

  it('retains accepted data and the screen on failure, using capped device backoff', () => {
    let state = drawn();
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      state = failRead(state, 'invalid or unavailable', 10_000);
      expect(state.nextPollAt).toBe(10_000 + delay);
      expect(state.displayed).toEqual(first); expect(state.received).toEqual(first);
    }
    state = acceptRead(state, first, 400_000).state;
    expect(state).toMatchObject({ failures: 0, error: null, nextPollAt: 430_000 });
  });

  it('does not draw a queued frame on network failure after the guard expires', () => {
    const pending = acceptRead(drawn(), second, 30_000).state;
    const failed = failRead(pending, 'offline', 60_000);
    expect(failed.displayed).toEqual(first);
    expect(failed.received).toEqual(second);
    expect(acceptRead(failed, frame('newest'), 90_000).frame?.revision).toBe('newest');
  });

  it('reconnects immediately without resetting the display guard', () => {
    const offline = changeConnection(drawn(), false, 10_000);
    expect(acceptRead(offline, second, 20_000)).toEqual({ state: offline, frame: null });
    const online = changeConnection(offline, true, 20_000);
    expect(online.nextPollAt).toBe(20_000);
    expect(guardRemaining(online, 20_000)).toBe(40_000);
    expect(acceptRead(online, second, 20_000).frame).toBeNull();
  });

  it('does not treat a failed display as successful and preserves its failure streak while deferred', () => {
    const failed = finishDisplay(acceptRead(drawn(), second, 60_000).state, second, 65_000, 'canvas error');
    expect(failed).toMatchObject({ screenValid: false, failures: 1, displayed: first, nextPollAt: 95_000 });
    const deferred = acceptRead(failed, first, 95_000);
    expect(deferred.frame).toBeNull(); expect(deferred.state.failures).toBe(1);
    const retry = acceptRead(deferred.state, first, 125_000);
    expect(retry.frame).toEqual(first);
    const recovered = finishDisplay(retry.state, first, 125_001);
    expect(recovered).toMatchObject({ screenValid: true, error: null, failures: 0 });
  });

  it('fast mode renders changed frames immediately, but switching back retains the last attempt time', () => {
    const state = drawn('fast');
    expect(state.nextPollAt).toBe(1000);
    const result = acceptRead(state, second, 1000);
    expect(result.frame).toEqual(second);
    const next = finishDisplay(result.state, second, 1001);
    const device = changeMode(next, 'device', 1500);
    expect(guardRemaining(device, 1500)).toBe(59_501);
    expect(failRead(state, 'offline', 1000).nextPollAt).toBe(2000);
  });
});
