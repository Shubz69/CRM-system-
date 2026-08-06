import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { jsonError, requirePermission } from "@/lib/session";

function maskSecret(value: string | undefined): string {
  if (!value) return "not set";
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export async function GET() {
  try {
    const session = await requirePermission("integrations:manage");
    const env = getEnv();
    const appUrl = env.APP_URL || env.NEXTAUTH_URL || "http://localhost:3000";

    const channels = await prisma.messagingChannel.findMany({
      where: { organisationId: session.organisationId, provider: "manychat" },
      orderBy: { createdAt: "asc" },
    });

    const secretConfigured = Boolean(env.MANYCHAT_WEBHOOK_SECRET);
    const apiTokenConfigured = Boolean(env.MANYCHAT_API_TOKEN);
    const connected = channels.some((c) => c.isActive) && secretConfigured;

    return Response.json({
      webhookUrl: `${appUrl.replace(/\/$/, "")}/api/webhooks/manychat`,
      secretConfigured,
      secretMasked: maskSecret(env.MANYCHAT_WEBHOOK_SECRET),
      apiTokenConfigured,
      channels,
      connected,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}
