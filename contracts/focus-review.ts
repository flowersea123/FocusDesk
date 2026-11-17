import { checkpointSourceLabel, type CheckpointSource } from './screen-checkpoint.ts';

export interface ReviewObservation {
  source?: CheckpointSource;
  appName?: string;
  taskId?: string | null;
  id: string;
  at: string;
  summary: string;
  nextStep?: string;
}

/** Older integrations supply manually confirmed observations without a source field. */
export type ConfirmedObservation = ReviewObservation;

export interface ReviewSegment {
  taskId: string;
  title: string;
  from: string;
  to: string;
  seconds: number;
  end: 'running' | 'stopped' | 'expired' | 'unobserved' | 'continued';
}

export interface ReviewExperiment {
  date: string;
  plan: string;
  outcome: string;
  revision: string;
}

export interface AppSession {
  appName: string;
  from: string;
  to: string;
  seconds: number;
}

export interface AiConversationFields {
  conversationId?: string;
  conversationTurnId?: string;
  conversationTitle?: string;
  userExcerpt?: string;
  assistantExcerpt?: string;
}

export interface AiSession extends AiConversationFields {
  runId: string;
  appName: string;
  title: string;
  from: string;
  to: string;
  state: 'running' | 'finished' | 'interrupted';
}

export interface FocusReview {
  date: string;
  today: string;
  timezone: string;
  trackingSince: string;
  partial: boolean;
  totalSeconds: number;
  sessions: ReviewSegment[];
  appSessions?: AppSession[];
  aiSessions?: AiSession[];
  aiUnavailable?: boolean;
  aiConversationSummaries?: Record<string, string>;
  observations: ReviewObservation[];
  summary: string;
  suggestion: { action: string; evidence: string } | null;
  experiment: ReviewExperiment | null;
  previousExperimentDate: string | null;
}

function shortDuration(seconds: number) {
  if (seconds < 60) return String(seconds) + ' 秒';
  return Math.floor(seconds / 60) + ' 分钟';
}

export function summarizeReview(sessions: ReviewSegment[], total: number, observations: ReviewObservation[], appSessions: AppSession[]) {
  const last = observations.at(-1);
  const most = sessions.reduce((best, s) => !best || s.seconds > best.seconds ? s : best, null as ReviewSegment | null);
  const timer = most ? '共 ' + sessions.length + ' 段计时，合计 ' + shortDuration(total) + '。' +
    '最长一段用于「' + most.title + '」。' : '这一天没有留下专注计时记录。';
  const appTotals = new Map<string, number>();
  for (const session of appSessions) appTotals.set(session.appName, (appTotals.get(session.appName) ?? 0) + session.seconds);
  const longestApp = [...appTotals].sort((a, b) => b[1] - a[1])[0];
  const appSummary = longestApp ? '记录到的前台应用中，' + longestApp[0] + ' 的时长最多，合计 ' +
    shortDuration(Math.floor(longestApp[1])) + '。' : '';
  const summary = (most || !appSummary ? timer : '') + appSummary + (last ? '最近一次' + checkpointSourceLabel(last.source) + '的屏幕观察写道：“' + last.summary + '”' : '');
  let next: ReviewObservation | undefined;
  for (let i = observations.length - 1; i >= 0; i--) {
    if (observations[i].nextStep?.trim()) { next = observations[i]; break; }
  }
  let suggestion: FocusReview['suggestion'] = null;
  if (next) suggestion = { action: next.nextStep!, evidence: '来自' + checkpointSourceLabel(next.source) + '的屏幕观察：“' + next.summary + '”' };
  else if (most) suggestion = {
    action: '下次开始「' + most.title + '」前，写下一项能在一段计时内检查的成果。结束后记下是否做到。',
    evidence: '该任务今天有一段 ' + shortDuration(most.seconds) + ' 的计时记录。',
  };
  else if (last) suggestion = {
    action: '下次开始前写下要完成的一个动作，结束时再确认一次屏幕观察，核对前后的变化。',
    evidence: '这一天共有 ' + observations.length + ' 条屏幕观察。',
  };
  return { summary, suggestion };
}
