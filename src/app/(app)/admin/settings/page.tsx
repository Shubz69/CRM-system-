import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";
import { GlobalSettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/dashboard");
  }

  const settings = await prisma.systemSetting.findMany({ orderBy: { key: "asc" } });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Global settings</h1>
        <p className="mt-1 text-[var(--muted)]">Platform-wide configuration stored as SystemSetting records.</p>
      </div>
      <GlobalSettingsForm initial={settings.map((s) => ({ key: s.key, value: s.value }))} />
    </div>
  );
}
