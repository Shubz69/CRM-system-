import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect("/login");
  }

  const headerList = await headers();
  const pathname = headerList.get("x-pathname") || "";
  const onChangePassword = pathname.startsWith("/account/change-password");

  if (session.user.mustChangePassword && !onChangePassword) {
    redirect("/account/change-password");
  }

  return (
    <AppShell
      orgName={session.user.organisationName}
      userName={session.user.name}
      isPlatformAdmin={Boolean(session.user.isPlatformAdmin)}
    >
      {children}
    </AppShell>
  );
}
