import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { hasUsableWorkspace } from "@/services/workspace-access";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  // A revoked token (suspended user, password changed elsewhere) keeps a user object
  // but loses its id — send it to sign-in instead of rendering a shell where every call 401s.
  if (!session?.user?.id) {
    redirect("/login");
  }

  // Signed in but no workspace to work in (removed from it, or it was suspended): every
  // API call would 401, so explain that instead of showing an empty desk. Platform admins
  // keep the shell — they reach the admin console with or without a workspace.
  if (
    !session.user.isPlatformAdmin &&
    !(await hasUsableWorkspace({
      userId: session.user.id,
      organisationId: session.user.organisationId,
    }))
  ) {
    redirect("/no-workspace");
  }

  const headerList = await headers();
  const pathname = headerList.get("x-pathname") || "";
  const onChangePassword = pathname.startsWith("/account/change-password");
  const mustChange = Boolean(session.user.mustChangePassword);

  if (mustChange && !onChangePassword) {
    redirect("/account/change-password");
  }

  return (
    <AppShell
      orgName={session.user.organisationName}
      userName={session.user.name}
      isPlatformAdmin={Boolean(session.user.isPlatformAdmin)}
      navigationLocked={mustChange}
    >
      {children}
    </AppShell>
  );
}
