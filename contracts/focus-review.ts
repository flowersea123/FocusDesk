export interface ConfirmedObservation {
  id: string;
  at: string;
  summary: string;
  nextStep?: string;
}

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

export interface FocusReview {
  date: string;
  today: string;
  timezone: string;
  trackingSince: string;
  partial: boolean;
  totalSeconds: number;
  sessions: ReviewSegment[];
  observations: ConfirmedObservation[];
  summary: string;
  suggestion: { action: string; evidence: string } | null;
  experiment: ReviewExperiment | null;
  previousExperimentDate: string | null;
}
