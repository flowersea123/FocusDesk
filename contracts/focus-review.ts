import type { CheckpointSource } from './screen-checkpoint.ts';

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

export interface FocusReview {
  date: string;
  today: string;
  timezone: string;
  trackingSince: string;
  partial: boolean;
  totalSeconds: number;
  sessions: ReviewSegment[];
  appSessions?: AppSession[];
  observations: ReviewObservation[];
  summary: string;
  suggestion: { action: string; evidence: string } | null;
  experiment: ReviewExperiment | null;
  previousExperimentDate: string | null;
}
