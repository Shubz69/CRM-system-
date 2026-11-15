/**
 * Customer labels for BusinessOpportunity statuses. The shared statusLabel() maps REJECTED to
 * "Needs attention" (right for content and jobs), but an opportunity the owner dismissed is
 * closed, not a problem — so opportunities use their own map.
 */
const OPPORTUNITY_STATUS_LABELS: Record<string, string> = {
  DETECTED: "New",
  REVIEWED: "Reviewed",
  ACCEPTED: "Accepted",
  PLANNED: "Planned",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  REJECTED: "Dismissed",
  DISMISSED: "Dismissed",
  EXPIRED: "Expired",
};

/** Still live: waiting for a decision or being worked on. */
export const OPEN_OPPORTUNITY_STATUSES: ReadonlySet<string> = new Set([
  "DETECTED",
  "REVIEWED",
  "ACCEPTED",
  "PLANNED",
  "IN_PROGRESS",
]);

export function opportunityStatusLabel(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return OPPORTUNITY_STATUS_LABELS[status] ?? status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
}

export function isOpenOpportunity(status: string | null | undefined): boolean {
  return Boolean(status && OPEN_OPPORTUNITY_STATUSES.has(status));
}

export function countOpenOpportunities(opportunities: Array<{ status: string }>): number {
  return opportunities.filter((o) => isOpenOpportunity(o.status)).length;
}
