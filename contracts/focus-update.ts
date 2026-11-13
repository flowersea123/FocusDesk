import { MAX_OVERVIEW_BYTES, OverviewValidationError } from './daily-overview.ts';

export type FocusUpdateRequest =
  | { revision: string; action: 'start'; task_id: string }
  | { revision: string; action: 'stop' };

export function parseFocusUpdateRequest(input: unknown): FocusUpdateRequest {
  const fail = (): never => { throw new OverviewValidationError('Send revision and action (start with task_id, or stop).'); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  const source = input as Record<string, unknown>;
  const id = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,64}$/.test(value);
  if (!id(source.revision)) return fail();
  if (source.action === 'stop' && Object.keys(source).every(key => ['revision', 'action'].includes(key))) {
    return { revision: source.revision, action: 'stop' };
  }
  if (source.action === 'start' && id(source.task_id) && Object.keys(source).every(key => ['revision', 'action', 'task_id'].includes(key))) {
    return { revision: source.revision, action: 'start', task_id: source.task_id };
  }
  return fail();
}

export function parseFocusUpdateText(body: string): FocusUpdateRequest {
  if (new TextEncoder().encode(body).byteLength > MAX_OVERVIEW_BYTES) {
    throw new OverviewValidationError('Focus update exceeds 4096 bytes');
  }
  let input: unknown;
  try { input = JSON.parse(body); }
  catch { throw new OverviewValidationError('Focus update must be valid JSON'); }
  return parseFocusUpdateRequest(input);
}
