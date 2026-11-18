import type { DailyWorkActivity, FocusReview, ReviewObservation } from './focus-review.ts';

export interface SynthesisObservation extends ReviewObservation {
  sourceLabel?: string;
  /** Verbatim conversation excerpts, including answers longer than the timeline preview. */
  sourceQuote?: string;
  workEvent?: { group: number; kind: DailyWorkActivity['events'][number]['kind']; text: string };
  /** The group's daily, de-duplicated outcomes. Stored once so both clients hash the exact item identities. */
  workItems?: Pick<DailyWorkActivity,'completedItems' | 'answeredItems'>;
}

/** The dashboard and Hub must hash the same dated evidence, including chat-only days. */
export function synthesisEvidence(review: Pick<FocusReview, 'observations' | 'workActivities'>): SynthesisObservation[] {
  if (!review.workActivities?.length) return review.observations;
  const records = new Map<string, SynthesisObservation>();
  const byTime = new Map<string, ReviewObservation[]>();
  for (const row of review.observations) {
    records.set(row.id, row);
    const at = byTime.get(row.at) ?? [];
    at.push(row);
    byTime.set(row.at, at);
  }
  const hasItems = review.workActivities.some(g => g.completedItems.length || g.answeredItems?.length);
  for (const [group, activity] of review.workActivities.entries()) {
    let needsItems = Boolean(activity.completedItems.length || activity.answeredItems?.length);
    for (const event of activity.events) {
      const candidates = event.kind === 'discussion' ? [] : byTime.get(event.at) ?? [];
      const original = candidates.find(row => row.summary === event.evidence) ??
        (candidates.length === 1 ? candidates[0] : undefined);
      const id = original?.id ?? JSON.stringify([activity.title, event.at, event.kind, event.source, event.text]);
      records.set(id, {
        ...original, id, at: event.at, summary: activity.title + ' · ' + event.text,
        source: original?.source ?? 'automatic', sourceLabel: event.source,
        ...(event.kind === 'discussion' ? { sourceQuote: event.evidence } : {}),
        ...(hasItems ? {workEvent:{group,kind:event.kind,text:event.text}} : {}),
        ...(needsItems && event.kind === 'work' ? {workItems:{completedItems:activity.completedItems, answeredItems:activity.answeredItems}} : {}),
      });
      if (event.kind === 'work') needsItems = false;
    }
  }
  return [...records.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
