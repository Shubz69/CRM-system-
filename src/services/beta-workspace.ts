/**
 * Beta workspace lifecycle preferences (OrganisationPreference — no schema migration).
 */

import { prisma } from "@/lib/db";
import {
  getOrganisationPreferences,
  setOrganisationPreference,
} from "@/services/agent-memory";

export const BETA_WORKSPACE_PREF_KEY = "beta_workspace";
export const ONBOARDING_PROGRESS_PREF_KEY = "workspace_onboarding_progress";

export type BetaWorkspaceStatus = "BETA_ACTIVE" | "BETA_SUSPENDED" | "BETA_COMPLETED";

export type BetaWorkspaceMeta = {
  status: BetaWorkspaceStatus;
  label?: string | null;
  expiresAt?: string | null;
  internalNotes?: string | null;
  createdByUserId?: string | null;
};

export type OnboardingProgress = {
  completed: boolean;
  skippedConnections?: boolean;
  currentStep?: number;
  businessName?: string;
  whatYouDo?: string;
  whoToReach?: string;
  agentBehaviour?: string;
  completedAt?: string | null;
};

export async function getBetaWorkspaceMeta(
  organisationId: string,
): Promise<BetaWorkspaceMeta | null> {
  const prefs = await getOrganisationPreferences({ organisationId });
  const raw = prefs[BETA_WORKSPACE_PREF_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const status = String(o.status || "");
  if (
    status !== "BETA_ACTIVE" &&
    status !== "BETA_SUSPENDED" &&
    status !== "BETA_COMPLETED"
  ) {
    return null;
  }
  return {
    status,
    label: typeof o.label === "string" ? o.label : null,
    expiresAt: typeof o.expiresAt === "string" ? o.expiresAt : null,
    internalNotes: typeof o.internalNotes === "string" ? o.internalNotes : null,
    createdByUserId: typeof o.createdByUserId === "string" ? o.createdByUserId : null,
  };
}

export async function setBetaWorkspaceMeta(input: {
  organisationId: string;
  meta: BetaWorkspaceMeta;
  updatedByUserId?: string | null;
}) {
  await setOrganisationPreference({
    organisationId: input.organisationId,
    key: BETA_WORKSPACE_PREF_KEY,
    value: input.meta,
    updatedByUserId: input.updatedByUserId,
  });
  return input.meta;
}

export async function getOnboardingProgress(
  organisationId: string,
): Promise<OnboardingProgress> {
  const prefs = await getOrganisationPreferences({ organisationId });
  const raw = prefs[ONBOARDING_PROGRESS_PREF_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { completed: false, currentStep: 0 };
  }
  const o = raw as Record<string, unknown>;
  return {
    completed: Boolean(o.completed),
    skippedConnections: Boolean(o.skippedConnections),
    currentStep: typeof o.currentStep === "number" ? o.currentStep : 0,
    businessName: typeof o.businessName === "string" ? o.businessName : undefined,
    whatYouDo: typeof o.whatYouDo === "string" ? o.whatYouDo : undefined,
    whoToReach: typeof o.whoToReach === "string" ? o.whoToReach : undefined,
    agentBehaviour: typeof o.agentBehaviour === "string" ? o.agentBehaviour : undefined,
    completedAt: typeof o.completedAt === "string" ? o.completedAt : null,
  };
}

export async function setOnboardingProgress(input: {
  organisationId: string;
  progress: OnboardingProgress;
  updatedByUserId?: string | null;
}) {
  await setOrganisationPreference({
    organisationId: input.organisationId,
    key: ONBOARDING_PROGRESS_PREF_KEY,
    value: input.progress,
    updatedByUserId: input.updatedByUserId,
  });
  return input.progress;
}

/** Default monthly AI cap for new beta workspaces (USD cents). */
export const BETA_DEFAULT_AI_MONTHLY_CAP_CENTS = 2_500; // $25
export const BETA_DEFAULT_AI_WARNING_THRESHOLD_CENTS = 2_000; // $20

export const AI_BUDGET_WARNING_PREF_KEY = "ai_budget_warning_threshold_cents";

export async function ensureBetaAiBudget(organisationId: string) {
  const { ensureBetaOrganisationAiBudget } = await import("@/services/ai-spend-gate");
  await ensureBetaOrganisationAiBudget(organisationId, BETA_DEFAULT_AI_MONTHLY_CAP_CENTS);
  const prefs = await getOrganisationPreferences({ organisationId });
  if (prefs[AI_BUDGET_WARNING_PREF_KEY]) return;
  await setOrganisationPreference({
    organisationId,
    key: AI_BUDGET_WARNING_PREF_KEY,
    value: { cents: BETA_DEFAULT_AI_WARNING_THRESHOLD_CENTS },
  });
}

export async function getAiBudgetWarningThresholdCents(
  organisationId: string,
): Promise<number | null> {
  const prefs = await getOrganisationPreferences({ organisationId });
  const raw = prefs[AI_BUDGET_WARNING_PREF_KEY];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const cents = Number((raw as { cents?: unknown }).cents);
    if (Number.isFinite(cents) && cents >= 0) return Math.floor(cents);
  }
  return null;
}

export async function countConnectedSocialAccounts(organisationId: string): Promise<number> {
  const profile = await prisma.zernioProfile.findUnique({
    where: { organisationId },
    select: { connectedAccounts: true },
  });
  const accounts = Array.isArray(profile?.connectedAccounts)
    ? (profile!.connectedAccounts as Array<{ status?: string; platform?: string }>)
    : [];
  return accounts.filter((a) => {
    const status = String(a.status || "connected").toLowerCase();
    if (status.includes("disconnect") || status === "revoked" || status === "inactive") {
      return false;
    }
    return Boolean(a.platform);
  }).length;
}
