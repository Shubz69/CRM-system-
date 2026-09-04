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

/** Internal phase labels — never expose provider names. */
export function customerFacingSynthesisPhase(
  phase:
    | "EVIDENCE_GATHERED"
    | "SYNTHESIS_FAILED"
    | "STRUCTURED_EXTRACTION_FAILED"
    | "GROUNDING_FAILED"
    | "QUALITY_REJECTED"
    | "SYNTHESIS_OK",
): string | null {
  switch (phase) {
    case "SYNTHESIS_FAILED":
      return "We found authoritative sources, but couldn't complete the analysis. Please try again shortly.";
    case "STRUCTURED_EXTRACTION_FAILED":
      return "We found and analysed the sources, but couldn't verify the answer structure reliably enough to present it as a completed research result.";
    case "GROUNDING_FAILED":
      return "We found sources, but couldn't reliably link the answer to evidence. Please try again shortly.";
    case "QUALITY_REJECTED":
      return "The answer did not meet our quality bar. Please try again or narrow the question.";
    case "EVIDENCE_GATHERED":
      return null;
    case "SYNTHESIS_OK":
      return null;
  }
}
