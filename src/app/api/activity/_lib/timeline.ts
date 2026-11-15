import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * One contact's history: CrmActivity rows for the contact (and its leads and deals), plus
 * its Notes and Bookings mapped into the same shape — newest first, cursor-paged.
 *
 * Ordering is (occurredAt desc, id desc) where `id` is "<source>:<rowId>", so the order is
 * total and a cursor resumes exactly after the last item even when timestamps tie.
 */
export type TimelineSource = "activity" | "note" | "booking";

export type TimelineItem = {
  /** "<source>:<rowId>" — unique across sources. */
  id: string;
  source: TimelineSource;
  sourceId: string;
  kind: string;
  title: string;
  body: string | null;
  occurredAt: string;
  dueAt: string | null;
  completedAt: string | null;
  createdBy: { id: string; name: string } | null;
  leadId: string | null;
  dealId: string | null;
  metadata: Record<string, unknown>;
};

export type TimelinePage = { items: TimelineItem[]; nextCursor: string | null };

export type TimelineCursor = { t: number; source: TimelineSource; id: string };

export const TIMELINE_DEFAULT_LIMIT = 50;
export const TIMELINE_MAX_LIMIT = 100;

const SOURCES: TimelineSource[] = ["activity", "note", "booking"];

export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return Buffer.from(`${cursor.t}|${cursor.source}|${cursor.id}`, "utf8").toString("base64url");
}

export function decodeTimelineCursor(raw: string): TimelineCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [t, source, id, ...rest] = decoded.split("|");
  if (rest.length > 0 || !t || !source || !id) return null;
  const ms = Number(t);
  if (!Number.isSafeInteger(ms) || ms < 0) return null;
  if (!SOURCES.includes(source as TimelineSource)) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return { t: ms, source: source as TimelineSource, id };
}

type CursorCondition = {
  createdAt?: { lt?: Date; lte?: Date };
  OR?: Array<{ createdAt: Date | { lt: Date }; id?: { lt: string } }>;
};

/**
 * Rows of `source` strictly after `cursor` in (createdAt desc, "<source>:<id>" desc) order.
 * At the cursor's exact timestamp, sources that sort below the cursor's source still have
 * every row left; sources above it have none; the same source continues by id.
 */
export function cursorCondition(
  source: TimelineSource,
  cursor: TimelineCursor | null,
): CursorCondition {
  if (!cursor) return {};
  const at = new Date(cursor.t);
  if (source < cursor.source) return { createdAt: { lte: at } };
  if (source > cursor.source) return { createdAt: { lt: at } };
  return { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function bookingTitle(status: string): string {
  switch (status) {
    case "OFFERED":
      return "Booking link sent";
    case "CREATED":
      return "Meeting booked";
    case "RESCHEDULED":
      return "Meeting rescheduled";
    case "CANCELLED":
      return "Booking cancelled";
    case "ATTENDED":
      return "Attended meeting";
    case "NO_SHOW":
      return "Missed meeting (no-show)";
    default:
      return "Booking updated";
  }
}

type Sortable = { item: TimelineItem; t: number; createdById: string | null };

/** Newest first; ties broken by source name desc, then each source's own (DB) order. */
function compareDesc(a: Sortable, b: Sortable): number {
  if (a.t !== b.t) return b.t - a.t;
  if (a.item.source === b.item.source) return 0;
  return a.item.source < b.item.source ? 1 : -1;
}

export async function loadContactTimeline(input: {
  organisationId: string;
  contactId: string;
  cursor: TimelineCursor | null;
  limit: number;
}): Promise<TimelinePage> {
  const { organisationId, contactId, cursor } = input;
  const limit = Math.min(Math.max(1, Math.floor(input.limit)), TIMELINE_MAX_LIMIT);
  const take = limit + 1;
  const order = [{ createdAt: "desc" as const }, { id: "desc" as const }];

  const activityScope: Prisma.CrmActivityWhereInput = {
    organisationId,
    OR: [
      { contactId },
      { lead: { contactId, organisationId } },
      { deal: { contactId, organisationId } },
    ],
  };

  // A note written in the inbox is both a Note row and a "note" activity (metadata.noteId);
  // a booking webhook event is an activity pointing at its Booking (metadata.bookingId).
  // List each once: the Note row stands for its note, the events stand for their booking.
  const linked = await prisma.crmActivity.findMany({
    where: { ...activityScope, kind: { in: ["note", "booking"] } },
    select: { id: true, kind: true, metadata: true },
    take: 2000,
  });
  const noteMirrorIds: string[] = [];
  const bookingsWithEvents = new Set<string>();
  for (const row of linked) {
    const meta = asRecord(row.metadata);
    if (row.kind === "note" && typeof meta.noteId === "string") noteMirrorIds.push(row.id);
    if (row.kind === "booking" && typeof meta.bookingId === "string") {
      bookingsWithEvents.add(meta.bookingId);
    }
  }

  const [activities, notes, bookings] = await Promise.all([
    prisma.crmActivity.findMany({
      where: {
        AND: [
          activityScope,
          cursorCondition("activity", cursor),
          noteMirrorIds.length > 0 ? { id: { notIn: noteMirrorIds } } : {},
        ],
      },
      orderBy: order,
      take,
      select: {
        id: true,
        kind: true,
        title: true,
        body: true,
        dueAt: true,
        completedAt: true,
        createdByUserId: true,
        leadId: true,
        dealId: true,
        metadata: true,
        createdAt: true,
      },
    }),
    prisma.note.findMany({
      where: { AND: [{ organisationId, contactId }, cursorCondition("note", cursor)] },
      orderBy: order,
      take,
      select: { id: true, body: true, authorId: true, conversationId: true, createdAt: true },
    }),
    prisma.booking.findMany({
      where: {
        AND: [
          { organisationId, contactId },
          cursorCondition("booking", cursor),
          bookingsWithEvents.size > 0 ? { id: { notIn: [...bookingsWithEvents] } } : {},
        ],
      },
      orderBy: order,
      take,
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        provider: true,
        leadId: true,
        createdAt: true,
      },
    }),
  ]);

  const merged: Sortable[] = [
    ...activities.map((row) => ({
      t: row.createdAt.getTime(),
      createdById: row.createdByUserId,
      item: {
        id: `activity:${row.id}`,
        source: "activity" as const,
        sourceId: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        occurredAt: row.createdAt.toISOString(),
        dueAt: row.dueAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        createdBy: null,
        leadId: row.leadId,
        dealId: row.dealId,
        metadata: asRecord(row.metadata),
      },
    })),
    ...notes.map((row) => ({
      t: row.createdAt.getTime(),
      createdById: row.authorId,
      item: {
        id: `note:${row.id}`,
        source: "note" as const,
        sourceId: row.id,
        kind: "note",
        title: "Note",
        body: row.body,
        occurredAt: row.createdAt.toISOString(),
        dueAt: null,
        completedAt: null,
        createdBy: null,
        leadId: null,
        dealId: null,
        metadata: { conversationId: row.conversationId },
      },
    })),
    ...bookings.map((row) => ({
      t: row.createdAt.getTime(),
      createdById: null,
      item: {
        id: `booking:${row.id}`,
        source: "booking" as const,
        sourceId: row.id,
        kind: "booking",
        title: bookingTitle(row.status),
        body: null,
        occurredAt: row.createdAt.toISOString(),
        dueAt: null,
        completedAt: null,
        createdBy: null,
        leadId: row.leadId,
        dealId: null,
        metadata: {
          bookingId: row.id,
          status: row.status,
          scheduledAt: row.scheduledAt?.toISOString() ?? null,
          provider: row.provider,
        },
      },
    })),
  ];

  // Stable sort: equal keys keep each source's DB order (createdAt desc, id desc).
  merged.sort(compareDesc);
  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    merged.length > limit && last
      ? encodeTimelineCursor({ t: last.t, source: last.item.source, id: last.item.sourceId })
      : null;

  const userIds = [...new Set(page.map((p) => p.createdById).filter((id): id is string => Boolean(id)))];
  const users =
    userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
  const names = new Map(users.map((u) => [u.id, u.name?.trim() || u.email]));

  return {
    items: page.map(({ item, createdById }) => ({
      ...item,
      createdBy: createdById ? { id: createdById, name: names.get(createdById) ?? "Former teammate" } : null,
    })),
    nextCursor,
  };
}
