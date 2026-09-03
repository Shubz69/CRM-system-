import { NextRequest } from "next/server";
import { z } from "zod";
import { DealStatus } from "@prisma/client";
import {
  requirePermission,
  requirePermissionForMutation,
  jsonError,
  WorkspaceChangedError,
  workspaceChangedJsonResponse,
} from "@/lib/session";
import { prisma } from "@/lib/db";
import { createDeal } from "@/services/crm-v2";

export async function GET() {
  try {
    const session = await requirePermission("leads:read");
    const deals = await prisma.deal.findMany({
      where: { organisationId: session.organisationId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: {
        company: { select: { id: true, name: true } },
        contact: { select: { id: true, fullName: true, email: true } },
      },
    });
    return Response.json({ deals });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  companyId: z.string().optional(),
  contactId: z.string().optional(),
  leadId: z.string().optional(),
  amountCents: z.number().int().nonnegative().optional(),
  currency: z.string().max(8).optional(),
  probability: z.number().min(0).max(1).nullable().optional(),
  stageLabel: z.string().max(80).optional(),
  summary: z.string().max(4000).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const body = createSchema.parse(raw);
    const id = await createDeal({
      organisationId: session.organisationId,
      ...body,
    });
    return Response.json({ id, organisationId: session.organisationId });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}

const patchSchema = z.object({
  id: z.string().min(1),
  status: z.nativeEnum(DealStatus).optional(),
  amountCents: z.number().int().nonnegative().nullable().optional(),
  probability: z.number().min(0).max(1).nullable().optional(),
  stageLabel: z.string().max(80).nullable().optional(),
  summary: z.string().max(4000).nullable().optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const body = patchSchema.parse(raw);
    const existing = await prisma.deal.findFirst({
      where: { id: body.id, organisationId: session.organisationId, deletedAt: null },
    });
    if (!existing) return jsonError("Deal not found", 404);

    const closed =
      body.status === DealStatus.WON ||
      body.status === DealStatus.LOST ||
      body.status === DealStatus.ABANDONED;

    const { appendDomainEvent } = await import("@/services/domain-events/append");
    await prisma.$transaction(async (tx) => {
      await tx.deal.update({
        where: { id: existing.id },
        data: {
          status: body.status,
          amountCents: body.amountCents === undefined ? undefined : body.amountCents,
          probability: body.probability === undefined ? undefined : body.probability,
          stageLabel: body.stageLabel === undefined ? undefined : body.stageLabel,
          summary: body.summary === undefined ? undefined : body.summary,
          closedAt: closed ? new Date() : body.status === DealStatus.OPEN ? null : undefined,
        },
      });

      if (body.status === DealStatus.WON && existing.status !== DealStatus.WON) {
        await appendDomainEvent(tx, {
          organisationId: session.organisationId,
          eventType: "DEAL_WON",
          aggregateType: "Deal",
          aggregateId: existing.id,
          payload: {
            dealId: existing.id,
            amountCents: body.amountCents ?? existing.amountCents,
            currency: existing.currency,
          },
        });
      } else if (body.status === DealStatus.LOST && existing.status !== DealStatus.LOST) {
        await appendDomainEvent(tx, {
          organisationId: session.organisationId,
          eventType: "DEAL_LOST",
          aggregateType: "Deal",
          aggregateId: existing.id,
          payload: { dealId: existing.id },
        });
      } else if (
        body.stageLabel !== undefined &&
        body.stageLabel !== existing.stageLabel &&
        body.stageLabel
      ) {
        await appendDomainEvent(tx, {
          organisationId: session.organisationId,
          eventType: "DEAL_STAGE_CHANGED",
          aggregateType: "Deal",
          aggregateId: existing.id,
          payload: {
            dealId: existing.id,
            fromStageLabel: existing.stageLabel,
            toStageLabel: body.stageLabel,
          },
        });
      }
    });
    return Response.json({ ok: true, organisationId: session.organisationId });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
