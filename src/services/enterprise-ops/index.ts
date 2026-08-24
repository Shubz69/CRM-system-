/**
 * Phase 18 — Enterprise operating layer helpers.
 * Maturity varies per surface: SLO/SSO = FOUNDATION; cost/RBAC/retention dry-run = WORKING.
 */

export {
  SLO_MATURITY_NOTE,
  captureOperationalSloSnapshot,
  getLatestOperationalSloSnapshot,
  peekSloIndicators,
  type SloIndicators,
} from "@/services/enterprise-ops/slo";

export {
  COST_ATTRIBUTIONS,
  CostOutcomeHonestyError,
  isCostAttribution,
  recordCostOutcomeLink,
  listCostOutcomeLinks,
  getCostOutcomePolicy,
  type CostAttribution,
} from "@/services/enterprise-ops/cost-outcomes";

export {
  ENTERPRISE_PERMISSION_KEYS,
  HIGH_RISK_PERMISSION_KEYS,
  isHighRiskPermission,
  enterpriseKeyToLegacy,
  roleHasEnterprisePermission,
  assertEnterprisePermission,
  assertStrongerThanRead,
  getRbacMatrixDocumentation,
  type EnterprisePermissionKey,
} from "@/services/enterprise-ops/rbac-matrix";

export {
  RETENTION_POLICIES,
  listRetentionPolicies,
  dryRunRetentionPurge,
  executeRetentionPurge,
  type RetentionPolicyId,
  type RetentionPolicyDescription,
  type RetentionDryRunResult,
} from "@/services/enterprise-ops/retention";

export {
  SSO_SCIM_MATURITY,
  getSsoScimReadiness,
  isSsoLive,
  isScimLive,
  type SsoScimReadiness,
} from "@/services/enterprise-ops/sso-scim";

import { peekSloIndicators } from "@/services/enterprise-ops/slo";
import { getCostOutcomePolicy } from "@/services/enterprise-ops/cost-outcomes";
import { getRbacMatrixDocumentation } from "@/services/enterprise-ops/rbac-matrix";
import { listRetentionPolicies } from "@/services/enterprise-ops/retention";
import { getSsoScimReadiness } from "@/services/enterprise-ops/sso-scim";

/**
 * Compact enterprise ops panel for AI Ops admin — real counts only, no fake charts.
 */
export async function getEnterpriseOpsPanel(organisationId?: string | null) {
  const [slo, sso] = await Promise.all([
    peekSloIndicators(organisationId),
    Promise.resolve(getSsoScimReadiness()),
  ]);

  return {
    slo: {
      maturityNote: "FOUNDATION" as const,
      indicators: slo,
      contractualSlo: false as const,
    },
    quality: {
      note: "Use evaluation/calibration services for hit-rate — not shown as invented uptime.",
      publishHealth: slo.publishSuccessRate,
    },
    costOutcomes: getCostOutcomePolicy(),
    rbac: getRbacMatrixDocumentation(),
    retention: {
      policies: listRetentionPolicies().map((p) => ({
        id: p.id,
        title: p.title,
        maturity: p.maturity,
        destructive: p.destructive,
      })),
    },
    ssoScim: {
      maturity: sso.maturity,
      liveProvidersConfigured: sso.liveProvidersConfigured,
      message: sso.message,
    },
  };
}
