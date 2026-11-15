import { NextRequest } from "next/server";
import { z } from "zod";
import {
  requirePermission,
  requirePermissionForMutation,
  jsonError,
  WorkspaceChangedError,
  workspaceChangedJsonResponse,
} from "@/lib/session";
import { prisma } from "@/lib/db";
import {
  CompanyConflictError,
  DealLinkError,
  softDeleteCompany,
  updateCompany,
} from "@/services/crm-v2";
import { recordCrmActivities } from "@/services/crm-activity";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requirePermission("leads:read");
    const { id } = await context.params;
    const company = await prisma.company.findFirst({
      where: { id, organisationId: session.organisationId, deletedAt: null },
      include: {
        contacts: {
          where: { deletedAt: null },
          orderBy: { lastContactAt: "desc" },
          take: 50,
          select: { id: true, fullName: true, email: true, lastContactAt: true },
        },
        deals: {
          where: { deletedAt: null },
          orderBy: { updatedAt: "desc" },
          take: 20,
          select: { id: true, name: true, status: true, amountCents: true, currency: true },
        },
        // Live (not soft-deleted) related rows only.
        _count: {
          select: {
            contacts: { where: { deletedAt: null } },
            deals: { where: { deletedAt: null } },
          },
        },
      },
    });
    if (!company) return jsonError("Company not found", 404);
    return Response.json({ organisationId: session.organisationId, company });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  domain: z.string().trim().max(200).nullable().optional(),
  website: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .refine((v) => !v || /^https?:\/\/\S+$/i.test(v), {
      message: "Website must be a full link starting with http:// or https://",
    }),
  industry: z.string().trim().max(100).nullable().optional(),
  sizeBand: z.string().trim().max(40).nullable().optional(),
});

function readableCompanyError(error: z.ZodError): string {
  const issue = error.issues[0];
  const field = String(issue?.path[0] ?? "");
  if (field === "name") return "Give the company a name (up to 200 characters).";
  if (field === "website") return "Website must be a full link starting with http:// or https://";
  if (field === "domain") return "Domain must be 200 characters or fewer.";
  if (field === "industry") return "Industry must be 100 characters or fewer.";
  return "Please check the company details and try again.";
}

function companyErrorResponse(error: unknown) {
  if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
  if (error instanceof z.ZodError) return jsonError(readableCompanyError(error), 400);
  if (error instanceof CompanyConflictError) return jsonError(error.message, 409);
  if (error instanceof DealLinkError) return jsonError("Company not found", 404);
  const message = error instanceof Error ? error.message : "Failed";
  if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
  if (message.startsWith("Forbidden")) return jsonError(message, 403);
  return jsonError(message, 400);
}

/** PATCH /api/companies/:id — edit name/domain/website/industry/size (leads:write, org-scoped). */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const { id } = await context.params;
    const body = patchSchema.parse(raw);
    const result = await updateCompany({
      organisationId: session.organisationId,
      companyId: id,
      ...body,
    });
    return Response.json({
      ok: true,
      id: result.id,
      changed: Object.keys(result.changed),
      organisationId: session.organisationId,
    });
  } catch (error) {
    return companyErrorResponse(error);
  }
}

/**
 * DELETE /api/companies/:id — soft delete. Linked deals and contacts keep working; they are just
 * no longer attached to the deleted account (each unlinked deal gets a timeline entry).
 */
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requirePermissionForMutation("leads:write", req, null);
    const { id } = await context.params;
    const result = await softDeleteCompany({ organisationId: session.organisationId, companyId: id });
    await recordCrmActivities(
      result.unlinkedDealIds.map((dealId) => ({
        organisationId: session.organisationId,
        kind: "deal_updated" as const,
        title: `Company removed from deal: ${result.name} was deleted`,
        dealId,
        createdByUserId: session.userId,
        metadata: { changes: { companyId: { from: result.id, to: null } }, companyDeleted: true },
      })),
    );
    return Response.json({
      ok: true,
      unlinkedDeals: result.unlinkedDealIds.length,
      unlinkedContacts: result.unlinkedContactIds.length,
      organisationId: session.organisationId,
    });
  } catch (error) {
    return companyErrorResponse(error);
  }
}
