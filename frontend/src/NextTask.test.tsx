import { expect, it } from 'vitest';
import type { DailyOverview } from '../../contracts/daily-overview';
import type { FocusReview } from '../../contracts/focus-review';
import { nextAction } from './NextTask';

const tasks: DailyOverview['tasks'] = [
  { id:'code', title:'Write tests', status:'todo', due_at:null },
  { id:'read', title:'Read the paper', status:'todo', due_at:'2026-11-16T09:00:00Z' },
  { id:'done', title:'Submit form', status:'done', due_at:null },
];
const overview: DailyOverview = { schema_version:'1.0', revision:'v1', timezone:'Asia/Shanghai', date:'2026-11-16',
  updated_at:'2026-11-16T08:10:00Z', tasks };
const review: FocusReview = { date:overview.date, today:overview.date, timezone:overview.timezone, trackingSince:overview.updated_at,
  partial:false, totalSeconds:0, sessions:[], observations:[], summary:'', suggestion:null, experiment:null, previousExperimentDate:null };
const observation = (taskId: string | null, minute: string, nextStep: string) => ({
  id:minute, at:'2026-11-16T08:' + minute + ':00Z', taskId, summary:'页面显示了结果', nextStep, appName:'Editor',
});

it('follows live focus, then latest unfinished work, without returning to completed or deleted tasks', () => {
  const focus = { task_id:'read', started_at:overview.updated_at, ends_at:'2026-11-16T08:35:00Z' };
  const day = { ...review, observations:[observation('code','04','补上边界测试。'), observation('read','05','读下一节。'),
    observation('done','07','已结束。'), observation('gone','08','已移除。')],
    sessions:[{ taskId:'code', title:'Write tests', from:'2026-11-16T08:01:00Z', to:'2026-11-16T08:06:00Z', seconds:300, end:'stopped' as const }] };
  expect(nextAction({...overview, focus}, day)).toMatchObject({ task:{id:'read'}, action:'读下一节。' });
  expect(nextAction(overview, day)).toMatchObject({ task:{id:'code'}, action:'补上边界测试。' });
  expect(nextAction(overview, review)?.task?.id).toBe('read');
  expect(nextAction({...overview, tasks:[tasks[0]]}, review)?.task?.id).toBe('code');
});

it('uses an unattributed but actionable observation without assigning it to an unrelated task', () => {
  const day = { ...review, observations:[observation(null,'05','核对图二的误差线。')] };
  const action = nextAction(overview, day);
  expect(action?.task).toBeUndefined();
  expect(action?.action).toBe('核对图二的误差线。');
  expect(action?.reason).toContain('16:05 Editor');
  expect(nextAction(overview, { ...review, observations:[observation(null,'06','')] })?.appName).toBe('Editor');
  expect(nextAction(overview, { ...review, appSessions:[{appName:'Preview',from:'2026-11-16T08:01:00Z',to:'2026-11-16T08:03:00Z',seconds:120}] })).toMatchObject({appName:'Preview', action:'回看 Preview 的最近活动'});
  expect(nextAction({...overview, tasks:[tasks[2]]}, review)).toBeNull();
});
