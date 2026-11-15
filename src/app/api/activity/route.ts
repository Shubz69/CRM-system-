import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { roleHasPermission } from "@/lib/permissions";
import { requirePermission, requirePermissionForMutation } from "@/lib/session";
import { MANUAL_ACTIVITY_KINDS, type CrmActivityKind } from "@/services/crm-activity";
import { readJsonObject, RouteError, routeErrorResponse } from "@/app/api/pipeline/_lib/http";
import {
  decodeTimelineCursor,
  loadContactTimeline,
  TIMELINE_DEFAULT_LIMIT,
  TIMELINE_MAX_LIMIT,
  type TimelineItem,
} from "./_lib/timeline";

const listSchema = z.object({
  contactId: z
    .string({ required_error: "contactId is required" })
    .trim()
    .min(1, "contactId is required"),
  cursor: z.string().max(400, "Invalid cursor").optional(),
  limit: z.coerce
    .number({ invalid_type_error: "limit must be a number" })
    .int("limit must be a whole number")
    .min(1, "limit must be at least 1")
    .max(TIMELINE_MAX_LIMIT, `limit can be at most ${TIMELINE_MAX_LIMIT}`)
    .optional(),
});

/** GET /api/activity?contactId=…&cursor=…&limit=… — the contact's merged timeline. */
export async function GET(req: NextRequest) {
  try {
    const session = await requirePermission("leads:read");
    const params = new URL(req.url).searchParams;
    const query = listSchema.parse({
      contactId: params.get("contactId") ?? undefined,
      cursor: params.get("cursor") || undefined,
      limit: params.get("limit") || undefined,
    });
    const cursor = query.cursor ? decodeTimelineCursor(query.cursor) : null;
    if (query.cursor && !cursor) throw new RouteError(400, "Invalid cursor — reload the timeline.");

    const contact = await prisma.contact.findFirst({
      where: { id: query.contactId, organisationId: session.organisationId, deletedAt: null },
      select: { id: true },
    });
    if (!contact) throw new RouteError(404, "Contact not found");

    const page = await loadContactTimeline({
      organisationId: session.organisationId,
      contactId: contact.id,
      cursor,
      limit: query.limit ?? TIMELINE_DEFAULT_LIMIT,
    });

    return Response.json({
      ...page,
      canWrite: roleHasPermission(session.role, "leads:write"),
    });
  } catch (error) {
    return routeErrorResponse(error, "Loading activity");
  }
}

const createSchema = z.object({
  contactId: z
    .string({ required_error: "contactId is required" })
    .trim()
    .min(1, "contactId is required"),
  kind: z
    .string({ required_error: "Choose what kind of activity this is" })
    .refine((k) => MANUAL_ACTIVITY_KINDS.includes(k as CrmActivityKind), {
      message: `Kind must be one of: ${MANUAL_ACTIVITY_KINDS.join(", ")}`,
    }),
  title: z
    .string({ required_error: "Title is required" })
    .trim()
    .min(1, "Title is required")
    .max(300, "Title must be 300 characters or fewer"),
  body: z
    .string()
    .max(10_000, "Notes must be 10,000 characters or fewer")
    .nullable()
    .optional(),
  dueAt: z
    .string()
    .datetime({ offset: true, message: "Due date must be a valid date and time" })
    .nullable()
    .optional(),
  leadId: z.string().min(1).optional(),
  dealId: z.string().min(1).optional(),
});

/** POST /api/activity — log a call, meeting, task or note against a contact. */
export async function POST(req: NextRequest) {
  try {
    const raw = await readJsonObject(req);
    const session = await requirePermissionForMutation("leads:write", req, raw);
    const body = createSchema.parse(raw);
    const kind = body.kind as CrmActivityKind;
    if (body.dueAt && kind !== "task") {
      throw new RouteError(400, "Only tasks can have a due date");
    }

    const contact = await prisma.contact.findFirst({
      where: { id: body.contactId, organisationId: session.organisationId, deletedAt: null },
      select: { id: true },
    });
    if (!contact) throw new RouteError(404, "Contact not found");

    if (body.leadId) {
      const lead = await prisma.lead.findFirst({
        where: { id: body.leadId, organisationId: session.organisationId, contactId: contact.id },
        select: { id: true },
      });
      if (!lead) throw new RouteError(404, "Lead not found for this contact");
    }
    if (body.dealId) {
      const deal = await prisma.deal.findFirst({
        where: {
          id: body.dealId,
          organisationId: session.organisationId,
          deletedAt: null,
          OR: [{ contactId: contact.id }, { lead: { contactId: contact.id } }],
        },
        select: { id: true },
      });
      if (!deal) throw new RouteError(404, "Deal not found for this contact");
    }

    const text = body.body?.trim() || null;
    const row = await prisma.crmActivity.create({
      data: {
        organisationId: session.organisationId,
        contactId: contact.id,
        leadId: body.leadId ?? null,
        dealId: body.dealId ?? null,
        kind,
        title: body.title,
        body: text,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        createdByUserId: session.userId,
        metadata: { manual: true },
      },
    });

    const item: TimelineItem = {
      id: `activity:${row.id}`,
      source: "activity",
      sourceId: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      occurredAt: row.createdAt.toISOString(),
      dueAt: row.dueAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdBy: {
        id: session.userId,
        name: session.name?.trim() || session.email || "You",
      },
      leadId: row.leadId,
      dealId: row.dealId,
      metadata: { manual: true },
    };
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    return routeErrorResponse(error, "Logging the activity");
  }
}
