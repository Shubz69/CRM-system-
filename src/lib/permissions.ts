import { MemberRole } from "@prisma/client";

export type Permission =
  | "org:manage"
  | "members:manage"
  | "integrations:manage"
  | "knowledge:manage"
  | "agent:manage"
  | "inbox:read"
  | "inbox:write"
  | "inbox:assign"
  | "leads:read"
  | "leads:write"
  | "pipeline:manage"
  | "insights:read"
  | "reports:read"
  | "reports:export"
  | "automations:manage"
  | "settings:read"
  | "audit:read";

const ROLE_PERMISSIONS: Record<MemberRole, Permission[]> = {
  OWNER: [
    "org:manage",
    "members:manage",
    "integrations:manage",
    "knowledge:manage",
    "agent:manage",
    "inbox:read",
    "inbox:write",
    "inbox:assign",
    "leads:read",
    "leads:write",
    "pipeline:manage",
    "insights:read",
    "reports:read",
    "reports:export",
    "automations:manage",
    "settings:read",
    "audit:read",
  ],
  ADMINISTRATOR: [
    "members:manage",
    "integrations:manage",
    "knowledge:manage",
    "agent:manage",
    "inbox:read",
    "inbox:write",
    "inbox:assign",
    "leads:read",
    "leads:write",
    "pipeline:manage",
    "insights:read",
    "reports:read",
    "reports:export",
    "automations:manage",
    "settings:read",
    "audit:read",
  ],
  MANAGER: [
    "knowledge:manage",
    "inbox:read",
    "inbox:write",
    "inbox:assign",
    "leads:read",
    "leads:write",
    "pipeline:manage",
    "insights:read",
    "reports:read",
    "reports:export",
    "automations:manage",
    "settings:read",
  ],
  SALES_AGENT: [
    "inbox:read",
    "inbox:write",
    "leads:read",
    "leads:write",
    "insights:read",
    "reports:read",
  ],
  ANALYST: ["inbox:read", "leads:read", "insights:read", "reports:read", "reports:export"],
  READ_ONLY: ["inbox:read", "leads:read", "insights:read", "reports:read", "settings:read"],
};

export function roleHasPermission(role: MemberRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function assertPermission(role: MemberRole, permission: Permission): void {
  if (!roleHasPermission(role, permission)) {
    throw new Error(`Forbidden: missing permission ${permission}`);
  }
}
