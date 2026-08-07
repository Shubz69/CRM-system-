import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/session";
import { WebhooksClient } from "./webhooks-client";

export const dynamic = "force-dynamic";

export default async function AdminWebhooksPage() {
  try {
    await requirePlatformAccess();
  } catch {
    redirect("/dashboard");
  }

  const events = await prisma.webhookEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      organisation: { select: { name: true, slug: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h-display text-4xl">Webhook events</h1>
        <p className="mt-1 text-[var(--muted)]">
          Real processing history. Retries are idempotent and audited.
        </p>
      </div>
      <WebhooksClient
        initial={events.map((event) => ({
          id: event.id,
          provider: event.provider,
          eventType: event.eventType,
          status: event.status,
          organisationName: event.organisation?.name || null,
          createdAt: event.createdAt.toISOString(),
          processedAt: event.processedAt?.toISOString() ?? null,
          error: event.error,
          idempotencyKey: event.idempotencyKey,
        }))}
      />
    </div>
  );
}
