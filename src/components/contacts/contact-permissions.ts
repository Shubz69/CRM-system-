import type { MemberRole } from "@prisma/client";
import { roleHasPermission } from "@/lib/permissions";

/**
 * Who may run the workspace-wide or destructive contact actions: merging two contacts, bulk
 * delete, bulk opt-out, renaming / recolouring / deleting tags (changes every tagged contact)
 * and CSV import that overwrites existing contacts (onDuplicate "update").
 *
 * Rule: the role must hold BOTH "leads:write" and "pipeline:manage". Today that is
 * OWNER, ADMINISTRATOR, MANAGER (and SUPER_ADMIN). Sales agents can still edit, tag,
 * create tags, import new contacts and add contacts to the pipeline, and delete or opt out
 * one contact at a time from its page.
 *
 * Shared by the API routes (enforcement) and the contacts pages (hiding the buttons).
 */
export function canManageContacts(role: MemberRole | string | null | undefined): boolean {
  if (!role) return false;
  return (
    roleHasPermission(role as MemberRole, "leads:write") &&
    roleHasPermission(role as MemberRole, "pipeline:manage")
  );
}

/** Can this role change contacts at all (tags, pipeline, import)? */
export function canWriteContacts(role: MemberRole | string | null | undefined): boolean {
  if (!role) return false;
  return roleHasPermission(role as MemberRole, "leads:write");
}

/** 403 text for an action that needs {@link canManageContacts}, e.g. "merging contacts". */
export function managerOnlyContactAction(action: string): string {
  return `Forbidden: ${action} needs an Owner, Administrator or Manager role.`;
}

export const DESTRUCTIVE_CONTACT_ACTION_FORBIDDEN = managerOnlyContactAction("merging or bulk-deleting contacts");
