import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requirePermission } from "@/lib/session";
import {
  getEntitlementsDashboard,
  syncEntitlementsFromPlan,
} from "@/services/entitlements";

export async function GET() {
  try {
    const session = await requirePermission("settings:read");
    const dashboard = await getEntitlementsDashboard(session.organisationId);
    return Response.json(dashboard);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const postSchema = z.object({
  action: z.literal("sync_from_plan"),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("org:manage");
    postSchema.parse(await req.json().catch(() => ({ action: "sync_from_plan" })));
    const dashboard = await syncEntitlementsFromPlan(session.organisationId);
    const full = await getEntitlementsDashboard(session.organisationId);
    return Response.json({ ...full, synced: dashboard });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (error instanceof z.ZodError) return jsonError("Invalid request", 400);
    return jsonError(message, 500);
  }
}
