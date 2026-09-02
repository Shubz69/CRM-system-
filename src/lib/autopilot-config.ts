export type AutopilotCapability =
  | "aiResponses"
  | "qualification"
  | "pipelineManagement"
  | "leadScoring"
  | "followUps"
  | "booking"
  | "contactEnrichment"
  | "insights"
  | "contentRecommendations";

export type AutopilotCapabilityMode = "automatic" | "approval_required" | "disabled";

export type AutopilotConfig = Record<AutopilotCapability, AutopilotCapabilityMode>;

export const DEFAULT_AUTOPILOT_CONFIG: AutopilotConfig = {
  aiResponses: "approval_required",
  qualification: "automatic",
  pipelineManagement: "automatic",
  leadScoring: "automatic",
  followUps: "approval_required",
  booking: "automatic",
  contactEnrichment: "automatic",
  insights: "automatic",
  contentRecommendations: "automatic",
};

export function parseAutopilotConfig(raw: unknown): AutopilotConfig {
  const base = { ...DEFAULT_AUTOPILOT_CONFIG };
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(base) as AutopilotCapability[]) {
    const value = obj[key];
    if (value === "automatic" || value === "approval_required" || value === "disabled") {
      base[key] = value;
    }
  }
  return base;
}
