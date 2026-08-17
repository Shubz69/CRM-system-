import { MemberRole } from "@prisma/client";

export type Permission =
  | "org:manage"
  | "members:manage"
  | "integrations:manage"
  | "knowledge:manage"
  | "agent:manage"
  | "ask:use"
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
  | "audit:read"
  | "platform:manage"
  | "users:manage"
  | "workspaces:manage"
  | "impersonate"
  | "system:health";

const ALL_WORKSPACE_PERMISSIONS: Permission[] = [
  "org:manage",
  "members:manage",
  "integrations:manage",
  "knowledge:manage",
  "agent:manage",
  "ask:use",
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
];

const PLATFORM_PERMISSIONS: Permission[] = [
  "platform:manage",
  "users:manage",
  "workspaces:manage",
  "impersonate",
  "system:health",
];

/** Viewer / read-only access */
const VIEWER_PERMISSIONS: Permission[] = [
  "inbox:read",
  "leads:read",
  "insights:read",
  "reports:read",
  "settings:read",
];

const ROLE_PERMISSIONS: Record<MemberRole, Permission[]> = {
  SUPER_ADMIN: [...ALL_WORKSPACE_PERMISSIONS, ...PLATFORM_PERMISSIONS],
  OWNER: [...ALL_WORKSPACE_PERMISSIONS],
  ADMINISTRATOR: [
    "members:manage",
    "integrations:manage",
    "knowledge:manage",
    "agent:manage",
    "ask:use",
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
    "ask:use",
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
    "ask:use",
    "inbox:read",
    "inbox:write",
    "leads:read",
    "leads:write",
    "insights:read",
    "reports:read",
  ],
  ANALYST: [
    "ask:use",
    "inbox:read",
    "leads:read",
    "insights:read",
    "reports:read",
    "reports:export",
  ],
  READ_ONLY: VIEWER_PERMISSIONS,
};

export function roleHasPermission(role: MemberRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function assertPermission(role: MemberRole, permission: Permission): void {
  if (!roleHasPermission(role, permission)) {
    throw new Error(`Forbidden: missing permission ${permission}`);
  }
}

export function getRolePermissions(role: MemberRole): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}
