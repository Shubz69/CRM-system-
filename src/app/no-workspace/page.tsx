import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { AuthFrame } from "@/components/ui/auth-frame";
import {
  loadUserWorkspaceMemberships,
  pickActiveWorkspace,
} from "@/services/active-workspace";
import { hasUsableWorkspace } from "@/services/workspace-access";
import { NoWorkspaceActions } from "./no-workspace-actions";

export const metadata = { title: "No workspace · Agent Desk" };

/**
 * Where (app) sends a signed-in user who has no workspace they can use — removed from it,
 * or its only workspace was suspended. Lives outside the (app) group so it renders without
 * the app shell (whose every request would 401).
 */
export default async function NoWorkspacePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect("/login");
  }
  if (session.user.isPlatformAdmin) {
    redirect("/admin");
  }
  if (
    await hasUsableWorkspace({
      userId: session.user.id,
      organisationId: session.user.organisationId,
    })
  ) {
    redirect("/home");
  }

  const memberships = await loadUserWorkspaceMemberships(session.user.id).catch(() => []);
  // Another workspace the user still belongs to (their session pointed at one they lost).
  const other = pickActiveWorkspace(memberships, null);
  const suspended = memberships.some(
    (m) => !m.organisation.deletedAt && m.organisation.status === "SUSPENDED",
  );

  return (
    <AuthFrame eyebrow="Agent Desk" title="You don't have access to a workspace">
      <p className="mt-3 text-sm text-[var(--muted)]">
        {suspended
          ? "The workspace your account belongs to has been suspended, so its desk, inbox and contacts aren't available right now."
          : "Your account isn't a member of any active workspace — you may have been removed from the team."}
      </p>
      <p className="mt-3 text-sm text-[var(--muted)]">
        {suspended
          ? "Ask your workspace owner or Agent Desk support to reactivate it."
          : "Ask your workspace admin to send you an invite, then open the invite link to get back in."}
      </p>
      {session.user.email ? (
        <p className="mt-4 text-xs text-[var(--muted)]">Signed in as {session.user.email}</p>
      ) : null}
      <NoWorkspaceActions
        otherWorkspace={
          other ? { id: other.organisationId, name: other.organisation.name } : null
        }
      />
    </AuthFrame>
  );
}
