import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";
import { PageHeader } from "@/components/ui/page-header";
import { GlobalSettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/home");
  }

  const settings = await prisma.systemSetting.findMany({ orderBy: { key: "asc" } });

  return (
    <div className="space-y-6">
      <PageHeader description="Platform-wide configuration stored as SystemSetting records." />
      <GlobalSettingsForm initial={settings.map((s) => ({ key: s.key, value: s.value }))} />
    </div>
  );
}
