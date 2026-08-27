/**
 * Phase 20 — Intelligence feature flags via OrganisationPreference.
 * Prefer existing preference store — do not invent a second flag system.
 */

import {
  getOrganisationPreferences,
  setOrganisationPreference,
} from "@/services/agent-memory";

export const INTELLIGENCE_FLAG_KEYS = [
  "computeGovernorEnabled",
  "businessStateEnabled",
  "evidenceDebtEnabled",
  "decisionLedgerEnabled",
  "creativeGenomeEnabled",
  "processTwinEnabled",
  "counterfactualEnabled",
  "toolTrustEnabled",
  /** When true (default), governor plans but legacy router remains active. */
  "computeGovernorShadowOnly",
  /** When true (default), L0 understanding runs in shadow without driving sends. */
  "messagingUnderstandingShadow",
  /** When true (default), NBA is computed in shadow and never double-sends. */
  "messagingNbaShadow",
] as const;

export type IntelligenceFlagKey = (typeof INTELLIGENCE_FLAG_KEYS)[number];

function readBool(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && "enabled" in value) {
    return Boolean((value as { enabled: unknown }).enabled);
  }
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
  }
  return defaultValue;
}

/** Missing preference → enabled (safe default for progressive rollout). */
export async function isIntelligenceFlagEnabled(
  organisationId: string,
  key: IntelligenceFlagKey,
): Promise<boolean> {
  const prefs = await getOrganisationPreferences({ organisationId });
  return readBool(prefs[key], true);
}

export async function setIntelligenceFlag(input: {
  organisationId: string;
  key: IntelligenceFlagKey;
  enabled: boolean;
  updatedByUserId?: string | null;
}): Promise<void> {
  await setOrganisationPreference({
    organisationId: input.organisationId,
    key: input.key,
    value: { enabled: input.enabled },
    updatedByUserId: input.updatedByUserId,
  });
}
