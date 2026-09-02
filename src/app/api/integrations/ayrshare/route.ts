import { NextRequest } from "next/server";
import { jsonError, requirePermission } from "@/lib/session";
import {
  createAyrshareSocialLink,
  getAyrshareProfileView,
  isAyrshareConfigured,
} from "@/adapters/ayrshare";

export async function GET() {
  try {
    const session = await requirePermission("settings:read");
    const view = await getAyrshareProfileView(session.organisationId);
    return Response.json({ ok: true, ...view, serverConfigured: isAyrshareConfigured() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError(message, 401);
    return jsonError(message, 403);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("integrations:manage");
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      networks?: string[];
    };
    const action = body.action || "create_social_link";

    if (action === "create_social_link") {
      const result = await createAyrshareSocialLink({
        organisationId: session.organisationId,
        networks: body.networks,
      });
      if (!result.ok) {
        return Response.json(result, { status: result.code === "AYRSHARE_NOT_CONFIGURED" ? 503 : 400 });
      }
      return Response.json(result);
    }

    return jsonError("Unknown action", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError(message, 401);
    return jsonError(message, 403);
  }
}
