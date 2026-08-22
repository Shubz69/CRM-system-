import { NextRequest } from "next/server";
import { z } from "zod";
import { requirePermission, jsonError } from "@/lib/session";
import { prisma } from "@/lib/db";
import {
  applyIndustryTemplate,
  INDUSTRY_TEMPLATES,
  type IndustryTemplateKey,
} from "@/services/crm-v2";

export async function GET() {
  try {
    const session = await requirePermission("leads:read");
    const org = await prisma.organisation.findUnique({
      where: { id: session.organisationId },
      select: { industryTemplateKey: true, industryTemplateConfig: true },
    });
    return Response.json({
      templates: INDUSTRY_TEMPLATES,
      appliedKey: org?.industryTemplateKey ?? null,
      appliedConfig: org?.industryTemplateConfig ?? {},
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const applySchema = z.object({
  key: z.enum(["generic", "agency", "b2b_saas", "creator", "coaching"]),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requirePermission("integrations:manage");
    const body = applySchema.parse(await req.json());
    await applyIndustryTemplate({
      organisationId: session.organisationId,
      key: body.key as IndustryTemplateKey,
    });
    return Response.json({ ok: true, key: body.key });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
