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

/** What each permission lets someone do, phrased to finish "You don't have permission to …". */
const PERMISSION_ACTIONS: Record<Permission, string> = {
  "org:manage": "manage this workspace",
  "members:manage": "manage team members",
  "integrations:manage": "manage integrations and messaging channels",
  "knowledge:manage": "manage the knowledge base",
  "agent:manage": "manage the AI agent",
  "ask:use": "use Ask",
  "inbox:read": "view the inbox",
  "inbox:write": "reply to conversations",
  "inbox:assign": "assign conversations",
  "leads:read": "view contacts and leads",
  "leads:write": "edit contacts, leads and deals",
  "pipeline:manage": "manage the pipeline",
  "insights:read": "view insights",
  "reports:read": "view reports",
  "reports:export": "export reports",
  "automations:manage": "manage automations and approvals",
  "settings:read": "view workspace settings",
  "audit:read": "view the audit log",
  "platform:manage": "use the platform admin tools",
  "users:manage": "manage platform users",
  "workspaces:manage": "manage workspaces",
  impersonate: "sign in as other users",
  "system:health": "view system health",
};

const MISSING_PERMISSION = /^Forbidden: missing permission\s*(\S*)\s*$/;

/**
 * Turn the internal "Forbidden: missing permission x:y" error into a sentence a person can act
 * on. Any other message is returned unchanged.
 */
export function readablePermissionError(message: string): string {
  const match = MISSING_PERMISSION.exec(message);
  if (!match) return message;
  const action = PERMISSION_ACTIONS[match[1] as Permission];
  return action
    ? `You don't have permission to ${action}. Ask a workspace owner or admin if you need it.`
    : "You don't have permission to do that. Ask a workspace owner or admin if you need it.";
}

export function getRolePermissions(role: MemberRole): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

/** Platform / workspace admins may see AI spend & allowance notes. Agents/viewers may not. */
export function canViewAiSpend(input: {
  isPlatformAdmin?: boolean;
  role: MemberRole;
}): boolean {
  if (input.isPlatformAdmin) return true;
  return (
    input.role === "SUPER_ADMIN" ||
    input.role === "OWNER" ||
    input.role === "ADMINISTRATOR"
  );
}
