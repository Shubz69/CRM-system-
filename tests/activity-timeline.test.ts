import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb } from "./helpers/fake-crm-db";
import {
  decodeTimelineCursor,
  encodeTimelineCursor,
} from "@/app/api/activity/_lib/timeline";

const sessionState = vi.hoisted(() => ({ role: "SALES_AGENT" as string }));

vi.mock("@/lib/db", async () => ({ prisma: (await import("./helpers/fake-crm-db")).fakeDb.prisma }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/session", async () => {
  const { roleHasPermission } = await vi.importActual<typeof import("@/lib/permissions")>(
    "@/lib/permissions",
  );
  class WorkspaceChangedError extends Error {}
  const guard = async (permission: string) => {
    if (!roleHasPermission(sessionState.role as never, permission as never)) {
      throw new Error(`Forbidden: missing permission ${permission}`);
    }
    return {
      userId: "user_1",
      organisationId: "org_1",
      role: sessionState.role,
      name: "Sam Seller",
      email: "sam@example.test",
    };
  };
  return {
    requirePermission: vi.fn(guard),
    requirePermissionForMutation: vi.fn(guard),
    jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
    WorkspaceChangedError,
    workspaceChangedJsonResponse: () => Response.json({ error: "workspace changed" }, { status: 409 }),
  };
});

const T0 = Date.parse("2026-10-01T09:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

function seed() {
  fakeDb.reset();
  fakeDb.seed("contact", [
    { id: "c1", organisationId: "org_1", deletedAt: null },
    { id: "c2", organisationId: "org_1", deletedAt: null },
    { id: "c_foreign", organisationId: "org_2", deletedAt: null },
  ]);
  fakeDb.seed("lead", [
    { id: "lead_c1", organisationId: "org_1", contactId: "c1", deletedAt: null },
    { id: "lead_c2", organisationId: "org_1", contactId: "c2", deletedAt: null },
  ]);
  fakeDb.seed("deal", [{ id: "deal_c1", organisationId: "org_1", contactId: "c1", leadId: null, deletedAt: null }]);
  fakeDb.seed("user", [
    { id: "u_ana", name: "Ana", email: "ana@example.test" },
    { id: "u_bo", name: null, email: "bo@example.test" },
  ]);
  fakeDb.seed("crmActivity", [
    { id: "a1", organisationId: "org_1", contactId: "c1", kind: "call", title: "Called", createdAt: at(10), createdByUserId: "u_ana" },
    { id: "a2", organisationId: "org_1", leadId: "lead_c1", kind: "stage_changed", title: "Moved", createdAt: at(20) },
    { id: "a3", organisationId: "org_1", dealId: "deal_c1", kind: "deal_updated", title: "Deal updated", createdAt: at(30) },
    { id: "a4", organisationId: "org_1", contactId: "c2", kind: "call", title: "Other contact", createdAt: at(40) },
    { id: "a5", organisationId: "org_2", contactId: "c1", kind: "call", title: "Other workspace", createdAt: at(45) },
    // Mirror of note n1 written from the inbox: listed once, as the Note.
    { id: "a_mirror", organisationId: "org_1", contactId: "c1", kind: "note", title: "Note added", createdAt: at(50), metadata: { noteId: "n1" } },
    // Booking event for b1: the event stands for the booking, so b1 itself isn't listed.
    { id: "a_book", organisationId: "org_1", contactId: "c1", kind: "booking", title: "Meeting booked", createdAt: at(60), metadata: { bookingId: "b1", status: "CREATED" } },
    { id: "a6", organisationId: "org_1", contactId: "c1", kind: "task", title: "Follow up", createdAt: at(70), dueAt: at(-60) },
    // Same-source tie: ordered by id desc.
    { id: "a7", organisationId: "org_1", contactId: "c1", kind: "meeting", title: "Meeting A", createdAt: at(80) },
    { id: "a8", organisationId: "org_1", contactId: "c1", kind: "meeting", title: "Meeting B", createdAt: at(80) },
  ]);
  fakeDb.seed("note", [
    { id: "n1", organisationId: "org_1", contactId: "c1", authorId: "u_bo", body: "Prefers mornings", conversationId: "conv_1", createdAt: at(50) },
    { id: "n2", organisationId: "org_1", contactId: "c1", authorId: null, body: "Tie note", conversationId: null, createdAt: at(70) },
    { id: "n_other", organisationId: "org_1", contactId: "c2", authorId: null, body: "Not c1", conversationId: null, createdAt: at(75) },
  ]);
  fakeDb.seed("booking", [
    { id: "b1", organisationId: "org_1", contactId: "c1", status: "CREATED", scheduledAt: at(2000), provider: "link", leadId: null, createdAt: at(5) },
    { id: "b2", organisationId: "org_1", contactId: "c1", status: "OFFERED", scheduledAt: null, provider: "link", leadId: "lead_c1", createdAt: at(70) },
    { id: "b3", organisationId: "org_1", contactId: "c1", status: "CANCELLED", scheduledAt: at(900), provider: "link", leadId: null, createdAt: at(1) },
  ]);
}

const EXPECTED_ORDER = [
  "activity:a8",
  "activity:a7",
  // Cross-source tie at the same instant: note > booking > activity.
  "note:n2",
  "booking:b2",
  "activity:a6",
  "activity:a_book",
  "note:n1",
  "activity:a3",
  "activity:a2",
  "activity:a1",
  "booking:b3",
];

async function getTimeline(query: string) {
  const { GET } = await import("@/app/api/activity/route");
  return GET(new NextRequest(`http://localhost/api/activity?${query}`));
}

describe("GET /api/activity", () => {
  beforeEach(() => {
    seed();
    sessionState.role = "SALES_AGENT";
  });

  it("merges the contact's activities (incl. its leads and deals), notes and bookings newest first", async () => {
    const res = await getTimeline("contactId=c1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items.map((i: { id: string }) => i.id)).toEqual(EXPECTED_ORDER);
    expect(json.nextCursor).toBeNull();
    expect(json.canWrite).toBe(true);

    const byId = Object.fromEntries(json.items.map((i: { id: string }) => [i.id, i]));
    expect(byId["activity:a1"].createdBy).toEqual({ id: "u_ana", name: "Ana" });
    expect(byId["note:n1"]).toMatchObject({
      kind: "note",
      body: "Prefers mornings",
      createdBy: { id: "u_bo", name: "bo@example.test" },
    });
    expect(byId["booking:b2"]).toMatchObject({ kind: "booking", title: "Booking link sent" });
    expect(byId["booking:b3"].metadata).toMatchObject({ status: "CANCELLED", scheduledAt: at(900).toISOString() });
    expect(byId["activity:a6"]).toMatchObject({ kind: "task", dueAt: at(-60).toISOString(), completedAt: null });
  });

  it("pages with a cursor without skipping or repeating items (ties included)", async () => {
    for (const limit of [1, 2, 3, 4]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const query: string = `contactId=c1&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const json = await (await getTimeline(query)).json();
        expect(json.items.length).toBeLessThanOrEqual(limit);
        seen.push(...json.items.map((i: { id: string }) => i.id));
        cursor = json.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(EXPECTED_ORDER);
    }
  });

  it("defaults to 50 items per page", async () => {
    fakeDb.seed(
      "crmActivity",
      Array.from({ length: 60 }, (_, i) => ({
        id: `bulk_${String(i).padStart(2, "0")}`,
        organisationId: "org_1",
        contactId: "c1",
        kind: "call",
        title: `Call ${i}`,
        createdAt: at(100 + i),
      })),
    );
    const json = await (await getTimeline("contactId=c1")).json();
    expect(json.items).toHaveLength(50);
    expect(json.items[0].id).toBe("activity:bulk_59");
    expect(json.nextCursor).toEqual(expect.any(String));
  });

  it("is scoped to the session's workspace and validates input", async () => {
    expect((await getTimeline("contactId=c_foreign")).status).toBe(404);
    expect((await getTimeline("contactId=missing")).status).toBe(404);

    const noContact = await getTimeline("");
    expect(noContact.status).toBe(400);
    expect((await noContact.json()).error).toBe("contactId is required");

    expect((await getTimeline("contactId=c1&cursor=garbage")).status).toBe(400);
    expect((await getTimeline("contactId=c1&limit=0")).status).toBe(400);
    expect((await getTimeline("contactId=c1&limit=500")).status).toBe(400);
  });

  it("read-only members can read but not write", async () => {
    sessionState.role = "READ_ONLY";
    const json = await (await getTimeline("contactId=c1")).json();
    expect(json.items.length).toBeGreaterThan(0);
    expect(json.canWrite).toBe(false);
  });

  it("round-trips cursors and rejects tampered ones", () => {
    const cursor = { t: at(5).getTime(), source: "note" as const, id: "abc123" };
    expect(decodeTimelineCursor(encodeTimelineCursor(cursor))).toEqual(cursor);
    expect(decodeTimelineCursor(Buffer.from("1|evil|x").toString("base64url"))).toBeNull();
    expect(decodeTimelineCursor(Buffer.from("x|note|abc").toString("base64url"))).toBeNull();
    expect(decodeTimelineCursor(Buffer.from("1|note|a'b").toString("base64url"))).toBeNull();
  });
});

async function postActivity(body: unknown) {
  const { POST } = await import("@/app/api/activity/route");
  return POST(
    new NextRequest("http://localhost/api/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/activity", () => {
  beforeEach(() => {
    seed();
    sessionState.role = "SALES_AGENT";
  });

  it("logs a task with a due date for the contact", async () => {
    const dueAt = "2026-11-20T10:00:00.000Z";
    const res = await postActivity({
      contactId: "c1",
      kind: "task",
      title: "  Send price list ",
      body: "PDF from Drive",
      dueAt,
    });
    expect(res.status).toBe(201);
    const { item } = await res.json();
    expect(item).toMatchObject({
      source: "activity",
      kind: "task",
      title: "Send price list",
      body: "PDF from Drive",
      dueAt,
      completedAt: null,
      createdBy: { id: "user_1", name: "Sam Seller" },
    });
    const row = fakeDb.tables.crmActivity.find((a) => a.id === item.sourceId)!;
    expect(row).toMatchObject({ organisationId: "org_1", contactId: "c1", createdByUserId: "user_1" });
    expect((row.dueAt as Date).toISOString()).toBe(dueAt);

    // It shows up first on the timeline.
    const json = await (await getTimeline("contactId=c1")).json();
    expect(json.items[0].id).toBe(item.id);
  });

  it("rejects bad input with readable messages", async () => {
    const due = await postActivity({ contactId: "c1", kind: "call", title: "Hi", dueAt: "2026-11-20T10:00:00Z" });
    expect(due.status).toBe(400);
    expect((await due.json()).error).toBe("Only tasks can have a due date");

    const kind = await postActivity({ contactId: "c1", kind: "email", title: "Hi" });
    expect(kind.status).toBe(400);
    expect((await kind.json()).error).toBe("Kind must be one of: call, meeting, task, note");

    const title = await postActivity({ contactId: "c1", kind: "note" });
    expect(title.status).toBe(400);
    expect((await title.json()).error).toBe("Title is required");

    const date = await postActivity({ contactId: "c1", kind: "task", title: "x", dueAt: "tomorrow" });
    expect((await date.json()).error).toBe("Due date must be a valid date and time");
    expect(fakeDb.prisma.crmActivity.create).not.toHaveBeenCalled();
  });

  it("refuses another workspace's contact, a lead of another contact, and read-only members", async () => {
    expect((await postActivity({ contactId: "c_foreign", kind: "call", title: "x" })).status).toBe(404);
    expect(
      (await postActivity({ contactId: "c1", kind: "call", title: "x", leadId: "lead_c2" })).status,
    ).toBe(404);
    sessionState.role = "READ_ONLY";
    expect((await postActivity({ contactId: "c1", kind: "call", title: "x" })).status).toBe(403);
    expect(fakeDb.prisma.crmActivity.create).not.toHaveBeenCalled();
  });
});

async function patchActivity(id: string, body: unknown) {
  const { PATCH } = await import("@/app/api/activity/[id]/route");
  return PATCH(
    new NextRequest(`http://localhost/api/activity/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("PATCH /api/activity/[id]", () => {
  beforeEach(() => {
    seed();
    sessionState.role = "SALES_AGENT";
  });

  it("marks a task done, keeps the first completion time, and can reopen it", async () => {
    const res = await patchActivity("a6", { completed: true });
    expect(res.status).toBe(200);
    const first = (await res.json()).completedAt as string;
    expect(first).toEqual(expect.any(String));
    const row = () => fakeDb.tables.crmActivity.find((a) => a.id === "a6")!;
    expect(row().completedAt).toBeInstanceOf(Date);
    expect(row().metadata).toMatchObject({ completedByUserId: "user_1" });

    const again = await (await patchActivity("a6", { completed: true })).json();
    expect(again.completedAt).toBe(first);

    const reopened = await (await patchActivity("a6", { completed: false })).json();
    expect(reopened.completedAt).toBeNull();
    expect(row().completedAt).toBeNull();

    const timeline = await (await getTimeline("contactId=c1")).json();
    expect(timeline.items.find((i: { id: string }) => i.id === "activity:a6").completedAt).toBeNull();
  });

  it("only tasks, only this workspace, only with leads:write", async () => {
    expect((await patchActivity("a1", { completed: true })).status).toBe(400);
    expect((await patchActivity("a5", { completed: true })).status).toBe(404);
    expect((await patchActivity("a6", {})).status).toBe(400);
    sessionState.role = "READ_ONLY";
    expect((await patchActivity("a6", { completed: true })).status).toBe(403);
    expect(fakeDb.tables.crmActivity.find((a) => a.id === "a6")!.completedAt).toBeNull();
  });
});
