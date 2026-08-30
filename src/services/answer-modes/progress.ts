export const CUSTOMER_PROGRESS_STAGES = {
  understanding: "Understanding your question",
  context: "Checking your business context",
  gathering: "Gathering evidence",
  crossChecking: "Cross-checking findings",
  preparing: "Preparing your answer",
} as const;

export type CustomerProgressStage =
  (typeof CUSTOMER_PROGRESS_STAGES)[keyof typeof CUSTOMER_PROGRESS_STAGES];

/** Map internal agent names to customer-facing progress copy. */
export function customerFacingLabelForAgent(agentName: string): string | null {
  switch (agentName) {
    case "research":
    case "social_listening":
      return CUSTOMER_PROGRESS_STAGES.gathering;
    case "analyst":
      return CUSTOMER_PROGRESS_STAGES.preparing;
    case "critic":
      return CUSTOMER_PROGRESS_STAGES.crossChecking;
    default:
      return null;
  }
}

export function customerFacingStatusForStep(status: "RUNNING" | "COMPLETED" | "FAILED"): string {
  switch (status) {
    case "RUNNING":
      return "In progress";
    case "COMPLETED":
      return "Done";
    case "FAILED":
      return "Couldn't finish";
  }
}
