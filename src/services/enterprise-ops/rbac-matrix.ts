/**
 * Phase 18 — RBAC permission matrix for enterprise surfaces.
 * High-risk actions require stronger than read.
 * Documents + enforces keys for CRM / Goals / Opportunities / Missions /
 * Approvals / Integrations / Credentials / Publishing / Admin / Billing / Audit / AI.
 */

import { MemberRole } from "@prisma/client";
import {
  assertPermission,
  roleHasPermission,
  type Permission,
} from "@/lib/permissions";

/**
 * Enterprise domain permission keys (string catalogue).
 * Mapped onto existing Permission where possible; high-risk documented explicitly.
 */
export const ENTERPRISE_PERMISSION_KEYS = [
  "crm:read",
  "crm:write",
  "goals:read",
  "goals:write",
  "opportunities:read",
  "opportunities:write",
  "missions:read",
  "missions:write",
  "missions:cancel",
  "approvals:read",
  "approvals:decide",
  "integrations:read",
  "integrations:manage",
  "credentials:read",
  "credentials:manage",
  "publishing:read",
  "publishing:execute",
  "admin:read",
  "admin:manage",
  "billing:read",
  "billing:manage",
  "audit:read",
  "audit:export",
  "ai:use",
  "ai:configure",
] as const;

export type EnterprisePermissionKey = (typeof ENTERPRISE_PERMISSION_KEYS)[number];

/** High-risk keys — must never be granted by read-only roles. */
export const HIGH_RISK_PERMISSION_KEYS: readonly EnterprisePermissionKey[] = [
  "crm:write",
  "goals:write",
  "opportunities:write",
  "missions:write",
  "missions:cancel",
  "approvals:decide",
  "integrations:manage",
  "credentials:manage",
  "publishing:execute",
  "admin:manage",
  "billing:manage",
  "audit:export",
  "ai:configure",
] as const;

/**
 * Map enterprise keys → existing Permission (closest gate).
 * Some keys share a coarse Permission until finer RBAC lands.
 */
const ENTERPRISE_TO_LEGACY: Record<EnterprisePermissionKey, Permission> = {
  "crm:read": "leads:read",
  "crm:write": "leads:write",
  "goals:read": "insights:read",
  "goals:write": "pipeline:manage",
  "opportunities:read": "insights:read",
  "opportunities:write": "pipeline:manage",
  "missions:read": "ask:use",
  "missions:write": "agent:manage",
  "missions:cancel": "agent:manage",
  "approvals:read": "automations:manage",
  "approvals:decide": "automations:manage",
  "integrations:read": "settings:read",
  "integrations:manage": "integrations:manage",
  "credentials:read": "settings:read",
  "credentials:manage": "integrations:manage",
  "publishing:read": "insights:read",
  "publishing:execute": "automations:manage",
  "admin:read": "settings:read",
  "admin:manage": "org:manage",
  "billing:read": "settings:read",
  "billing:manage": "org:manage",
  "audit:read": "audit:read",
  "audit:export": "reports:export",
  "ai:use": "ask:use",
  "ai:configure": "agent:manage",
};

export function isHighRiskPermission(key: EnterprisePermissionKey): boolean {
  return (HIGH_RISK_PERMISSION_KEYS as readonly string[]).includes(key);
}

export function enterpriseKeyToLegacy(key: EnterprisePermissionKey): Permission {
  return ENTERPRISE_TO_LEGACY[key];
}

export function roleHasEnterprisePermission(
  role: MemberRole,
  key: EnterprisePermissionKey,
): boolean {
  if (isHighRiskPermission(key) && role === MemberRole.READ_ONLY) {
    return false;
  }
  return roleHasPermission(role, ENTERPRISE_TO_LEGACY[key]);
}

export function assertEnterprisePermission(
  role: MemberRole,
  key: EnterprisePermissionKey,
): void {
  if (!roleHasEnterprisePermission(role, key)) {
    throw new Error(`Forbidden: missing enterprise permission ${key}`);
  }
  // Also enforce legacy gate for defence-in-depth
  assertPermission(role, ENTERPRISE_TO_LEGACY[key]);
}

/**
 * Stronger-than-read check: write/execute keys reject when role only has the read twin.
 */
export function assertStrongerThanRead(
  role: MemberRole,
  key: EnterprisePermissionKey,
): void {
  if (!isHighRiskPermission(key)) {
    assertEnterprisePermission(role, key);
    return;
  }
  if (role === MemberRole.READ_ONLY || role === MemberRole.ANALYST) {
    // Analyst may export reports but not credentials/publishing/admin
    if (
      key === "credentials:manage" ||
      key === "publishing:execute" ||
      key === "admin:manage" ||
      key === "billing:manage" ||
      key === "missions:cancel"
    ) {
      throw new Error(`Forbidden: ${key} requires stronger than read/analyst`);
    }
  }
  assertEnterprisePermission(role, key);
}

export function getRbacMatrixDocumentation() {
  return {
    maturity: "WORKING" as const,
    keys: ENTERPRISE_PERMISSION_KEYS,
    highRisk: HIGH_RISK_PERMISSION_KEYS,
    policy:
      "High-risk actions (write/manage/execute/export) require stronger than read. Mapped to legacy Permission gates until finer RBAC ships.",
    mapping: ENTERPRISE_TO_LEGACY,
  };
}
