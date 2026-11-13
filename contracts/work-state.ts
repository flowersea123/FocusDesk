import { OverviewValidationError } from './daily-overview.ts';

export interface WorkState { goal: string; current_action: string; next_action: string }
export type SignalPriority = 'normal' | 'action_needed' | 'urgent';
export type SignalStatus = 'active' | 'acknowledged' | 'ignored' | 'closed';
export interface WorkSignal {
  id: string;
  content: string;
  source: string;
  created_at: string;
  priority: SignalPriority;
  status: SignalStatus;
}
export interface WorkStateUpdateRequest { revision: string; work_state: WorkState; signals: WorkSignal[] }
export const EMPTY_WORK_STATE: WorkState = { goal: '', current_action: '', next_action: '' };
export const MAX_SIGNALS = 4;

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new OverviewValidationError('Unsupported work state fields');
  }
  return value as Record<string, unknown>;
}
function ascii(value: unknown, max: number, blank = false): string {
  if (typeof value !== 'string' || value.length > max || /[^\x20-\x7e]/.test(value) || (!blank && !value.trim())) {
    throw new OverviewValidationError(`Use ${blank ? '0' : '1'}-${max} printable ASCII characters`);
  }
  return value;
}
export function parseWorkState(value: unknown): WorkState {
  const item = object(value, ['goal', 'current_action', 'next_action']);
  return { goal: ascii(item.goal, 64, true), current_action: ascii(item.current_action, 64, true), next_action: ascii(item.next_action, 64, true) };
}
export function parseSignals(value: unknown): WorkSignal[] {
  if (!Array.isArray(value) || value.length > MAX_SIGNALS) throw new OverviewValidationError('At most 4 signals can be saved');
  const ids = new Set<string>();
  return value.map(raw => {
    const item = object(raw, ['id', 'content', 'source', 'created_at', 'priority', 'status']);
    const id = ascii(item.id, 64);
    if (/\s/.test(id) || ids.has(id)) throw new OverviewValidationError('Signal IDs must be unique and contain no spaces');
    ids.add(id);
    const content = ascii(item.content, 96);
    const source = ascii(item.source, 24);
    if (typeof item.created_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.created_at) ||
        !Number.isFinite(Date.parse(item.created_at)) || new Date(item.created_at).toISOString() !== item.created_at) {
      throw new OverviewValidationError('Signal time must be a canonical UTC timestamp');
    }
    if (!['normal', 'action_needed', 'urgent'].includes(item.priority as string) ||
        !['active', 'acknowledged', 'ignored', 'closed'].includes(item.status as string)) {
      throw new OverviewValidationError('Unsupported signal priority or status');
    }
    return { id, content, source, created_at: item.created_at, priority: item.priority as SignalPriority, status: item.status as SignalStatus };
  });
}
export function parseWorkStateUpdateRequest(value: unknown): WorkStateUpdateRequest {
  const item = object(value, ['revision', 'work_state', 'signals']);
  const revision = ascii(item.revision, 64);
  if (/\s/.test(revision)) throw new OverviewValidationError('Invalid revision');
  return { revision, work_state: parseWorkState(item.work_state), signals: parseSignals(item.signals) };
}
export function parseWorkStateUpdateText(body: string): WorkStateUpdateRequest {
  if (new TextEncoder().encode(body).length > 4096) throw new OverviewValidationError('Work state update exceeds 4096 bytes');
  let input: unknown;
  try { input = JSON.parse(body); } catch { throw new OverviewValidationError('Work state update must be JSON'); }
  return parseWorkStateUpdateRequest(input);
}
