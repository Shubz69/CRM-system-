import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  // A revoked token (suspended user, password changed elsewhere) keeps a user object
  // but loses its id — send it to sign-in instead of rendering a shell where every call 401s.
  if (!session?.user?.id) {
    redirect("/login");
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
