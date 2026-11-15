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
import {
  assertDealLinksInOrganisation,
  createDeal,
  DEAL_CURRENCIES,
  DealLinkError,
  getDefaultDealCurrency,
  normaliseDealCurrency,
} from "@/services/crm-v2";
import { recordCrmActivity } from "@/services/crm-activity";

/** ISO 4217 code (any case) → upper-case; anything else is a readable 400. */
const currencySchema = z
  .string()
  .transform((value) => normaliseDealCurrency(value))
  .refine((value): value is string => value !== null, {
    message: "Choose a valid currency (for example GBP, EUR or USD).",
  });

function readableDealError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Please check the deal and try again.";
  const field = String(issue.path[0] ?? "");
  if (field === "currency") return "Choose a valid currency (for example GBP, EUR or USD).";
  if (field === "name") return "Give the deal a name (up to 200 characters).";
  if (field === "amountCents") return "Amount must be zero or more.";
  if (field === "probability") return "Probability must be between 0% and 100%.";
  if (field === "stageLabel") return "Stage must be 80 characters or fewer.";
  return "Please check the deal and try again.";
}

export async function GET(req: Request) {
  try {
    const session = await requirePermission("leads:read");
    const { searchParams } = new URL(req.url);

    // Overview numbers: real counts (not a capped list) and open value per currency.
    if (searchParams.get("summary") === "1") {
      const openWhere = {
        organisationId: session.organisationId,
        deletedAt: null,
        status: DealStatus.OPEN,
        // A deleted contact's deals leave the totals with it (deals without a contact stay).
        OR: [{ contactId: null }, { contact: { deletedAt: null } }],
      };
      const [openDeals, byCurrency] = await Promise.all([
        prisma.deal.count({ where: openWhere }),
        prisma.deal.groupBy({
          by: ["currency"],
          where: openWhere,
          _sum: { amountCents: true },
        }),
      ]);
      return Response.json({
        openDeals,
        openValueByCurrency: byCurrency
          .map((row) => ({ currency: row.currency, amountCents: row._sum.amountCents ?? 0 }))
          .filter((row) => row.amountCents > 0)
          .sort((a, b) => b.amountCents - a.amountCents),
      });
    }

    const rows = await prisma.deal.findMany({
      where: { organisationId: session.organisationId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: {
        company: { select: { id: true, name: true, organisationId: true } },
        contact: { select: { id: true, fullName: true, email: true, organisationId: true } },
      },
    });
    // Never echo another workspace's company/contact through a mis-linked deal.
    const deals = rows.map(({ company, contact, ...deal }) => ({
      ...deal,
      company:
        company && company.organisationId === session.organisationId
          ? { id: company.id, name: company.name }
          : null,
      contact:
        contact && contact.organisationId === session.organisationId
          ? { id: contact.id, fullName: contact.fullName, email: contact.email }
          : null,
    }));
    const defaultCurrency = await getDefaultDealCurrency(session.organisationId);
    return Response.json({ deals, defaultCurrency, currencies: DEAL_CURRENCIES });
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
  currency: currencySchema.optional(),
  probability: z.number().min(0).max(1).nullable().optional(),
  stageLabel: z.string().max(80).optional(),
  summary: z.string().max(4000).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const body = createSchema.parse(raw);
    const currency = body.currency ?? (await getDefaultDealCurrency(session.organisationId));
    // createDeal rejects company/contact/lead ids from another workspace (DealLinkError → 400).
    const id = await createDeal({
      organisationId: session.organisationId,
      ...body,
      currency,
    });
    // Best-effort timeline entry (links were validated by createDeal).
    await recordCrmActivity({
      organisationId: session.organisationId,
      kind: "deal_created",
      title: `Deal created: ${body.name.trim()}`,
      contactId: body.contactId ?? null,
      leadId: body.leadId ?? null,
      dealId: id,
      companyId: body.companyId ?? null,
      createdByUserId: session.userId,
      metadata: {
        amountCents: body.amountCents ?? null,
        currency,
        stageLabel: body.stageLabel ?? null,
      },
    });
    return Response.json({ id, organisationId: session.organisationId });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    if (error instanceof DealLinkError) return jsonError(error.message, 400);
    if (error instanceof z.ZodError) return jsonError(readableDealError(error), 400);
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}

const patchSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200).optional(),
  status: z.nativeEnum(DealStatus).optional(),
  amountCents: z.number().int().nonnegative().nullable().optional(),
  currency: currencySchema.optional(),
  probability: z.number().min(0).max(1).nullable().optional(),
  stageLabel: z.string().max(80).nullable().optional(),
  summary: z.string().max(4000).nullable().optional(),
  /** null unlinks; a new id must belong to this workspace (checked below). */
  companyId: z.string().min(1).nullable().optional(),
  contactId: z.string().min(1).nullable().optional(),
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

    // Re-linking: only new ids are looked up, always inside this workspace (DealLinkError → 400).
    const companyChanged = body.companyId !== undefined && body.companyId !== existing.companyId;
    const contactChanged = body.contactId !== undefined && body.contactId !== existing.contactId;
    await assertDealLinksInOrganisation({
      organisationId: session.organisationId,
      companyId: companyChanged ? body.companyId : null,
      contactId: contactChanged ? body.contactId : null,
    });

    const closed =
      body.status === DealStatus.WON ||
      body.status === DealStatus.LOST ||
      body.status === DealStatus.ABANDONED;

    const { appendDomainEvent } = await import("@/services/domain-events/append");
    await prisma.$transaction(async (tx) => {
      await tx.deal.update({
        where: { id: existing.id },
        data: {
          name: body.name,
          status: body.status,
          amountCents: body.amountCents === undefined ? undefined : body.amountCents,
          currency: body.currency,
          probability: body.probability === undefined ? undefined : body.probability,
          stageLabel: body.stageLabel === undefined ? undefined : body.stageLabel,
          summary: body.summary === undefined ? undefined : body.summary,
          companyId: companyChanged ? body.companyId : undefined,
          contactId: contactChanged ? body.contactId : undefined,
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
            currency: body.currency ?? existing.currency,
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

    // Best-effort timeline entry with just the fields that actually changed.
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const fields = [
      "name",
      "status",
      "amountCents",
      "currency",
      "probability",
      "stageLabel",
      "summary",
      "companyId",
      "contactId",
    ] as const;
    for (const field of fields) {
      const next = body[field];
      if (next !== undefined && next !== existing[field]) {
        changes[field] = { from: existing[field], to: next };
      }
    }
    if (Object.keys(changes).length > 0) {
      const statusChanged = changes.status !== undefined;
      const dealName = body.name ?? existing.name;
      await recordCrmActivity({
        organisationId: session.organisationId,
        kind: "deal_updated",
        title:
          statusChanged && body.status === DealStatus.WON
            ? `Deal won: ${dealName}`
            : statusChanged && body.status === DealStatus.LOST
              ? `Deal lost: ${dealName}`
              : `Deal updated: ${dealName}`,
        // Re-linked deals land on the new contact/company timeline.
        contactId: contactChanged ? (body.contactId ?? null) : existing.contactId,
        leadId: existing.leadId,
        dealId: existing.id,
        companyId: companyChanged ? (body.companyId ?? null) : existing.companyId,
        createdByUserId: session.userId,
        metadata: { changes },
      });
    }
    return Response.json({ ok: true, organisationId: session.organisationId });
  } catch (error) {
    if (error instanceof WorkspaceChangedError) return workspaceChangedJsonResponse();
    if (error instanceof DealLinkError) return jsonError(error.message, 400);
    if (error instanceof z.ZodError) return jsonError(readableDealError(error), 400);
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}

/**
 * DELETE /api/deals?id=… — soft delete (deletedAt), org-scoped. The deal leaves lists and totals;
 * its timeline history stays.
 */
export async function DELETE(req: NextRequest) {
  try {
    const session = await requirePermissionForMutation("leads:write", req, null);
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return jsonError("Choose a deal to delete.", 400);
    const existing = await prisma.deal.findFirst({
      where: { id, organisationId: session.organisationId, deletedAt: null },
    });
    if (!existing) return jsonError("Deal not found", 404);
    const removed = await prisma.deal.updateMany({
      where: { id: existing.id, organisationId: session.organisationId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (removed.count === 0) return jsonError("Deal not found", 404);
    await recordCrmActivity({
      organisationId: session.organisationId,
      kind: "deal_updated",
      title: `Deal deleted: ${existing.name}`,
      contactId: existing.contactId,
      leadId: existing.leadId,
      dealId: existing.id,
      companyId: existing.companyId,
      createdByUserId: session.userId,
      metadata: { deleted: true },
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
