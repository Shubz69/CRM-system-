/**
 * Knowledge gaps: only open recommendations are listed, Dismiss closes them, Approve turns the
 * answer into a Knowledge document via the knowledge service. Ask drafts no longer overwrite each
 * other when saved on the same day.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  recFindMany: vi.fn(),
  recFindFirst: vi.fn(),
  recUpdateMany: vi.fn(),
  docFindMany: vi.fn(),
  docUpdate: vi.fn(),
  upsertKnowledgeDocument: vi.fn(),
  recordRecommendationFeedback: vi.fn(),
}));

vi.mock("@/lib/session", () => {
  class WorkspaceChangedError extends Error {}
  return {
    requirePermission: vi.fn(async () => ({ organisationId: "org_a", userId: "u1" })),
    requirePermissionForMutation: vi.fn(async () => ({ organisationId: "org_a", userId: "u1" })),
    jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
    WorkspaceChangedError,
    workspaceChangedJsonResponse: () => Response.json({ error: "changed" }, { status: 409 }),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    knowledgeRecommendation: {
      findMany: (...args: unknown[]) => mocks.recFindMany(...args),
      findFirst: (...args: unknown[]) => mocks.recFindFirst(...args),
      updateMany: (...args: unknown[]) => mocks.recUpdateMany(...args),
    },
    knowledgeDocument: {
      findMany: (...args: unknown[]) => mocks.docFindMany(...args),
      update: (...args: unknown[]) => mocks.docUpdate(...args),
    },
  },
}));

vi.mock("@/services/knowledge", () => ({
  upsertKnowledgeDocument: (...args: unknown[]) => mocks.upsertKnowledgeDocument(...args),
  chunkText: (content: string) => (content ? [content] : []),
  updateKnowledgeDocument: vi.fn(),
  archiveKnowledgeDocument: vi.fn(),
}));

vi.mock("@/services/learning-os", () => ({
  recordRecommendationFeedback: (...args: unknown[]) => mocks.recordRecommendationFeedback(...args),
}));

vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn() }));

import { GET, PATCH } from "@/app/api/knowledge/recommendations/route";
import { POST as createKnowledge } from "@/app/api/knowledge/route";

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/knowledge/recommendations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const openRec = {
  id: "rec_1",
  organisationId: "org_a",
  question: "Do you work with companies outside the UK?",
  draftAnswer: null,
  status: "NEW",
};

describe("/api/knowledge/recommendations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recFindMany.mockResolvedValue([]);
    mocks.recFindFirst.mockResolvedValue(openRec);
    mocks.recUpdateMany.mockResolvedValue({ count: 1 });
    mocks.upsertKnowledgeDocument.mockResolvedValue("doc_1");
  });

  it("GET returns only open recommendations", async () => {
    await GET();
    expect(mocks.recFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organisationId: "org_a", status: { in: ["NEW", "REVIEWED"] } },
      }),
    );
  });

  it("Approve without an answer is a 400 and creates nothing", async () => {
    const res = await patch({ id: "rec_1", status: "APPROVED" });
    expect(res.status).toBe(400);
    expect(mocks.upsertKnowledgeDocument).not.toHaveBeenCalled();
    expect(mocks.recUpdateMany).not.toHaveBeenCalled();
  });

  it("Approve with an answer creates the knowledge document, then closes the gap", async () => {
    const res = await patch({ id: "rec_1", status: "APPROVED", draftAnswer: "Yes — UK and EU." });
    expect(res.status).toBe(200);
    expect(mocks.upsertKnowledgeDocument).toHaveBeenCalledWith({
      organisationId: "org_a",
      title: "Do you work with companies outside the UK?",
      category: "faq",
      content: "Q: Do you work with companies outside the UK?\n\nA: Yes — UK and EU.",
      tags: ["knowledge-gap"],
    });
    expect(mocks.recUpdateMany).toHaveBeenCalledWith({
      where: { id: "rec_1", organisationId: "org_a" },
      data: { status: "APPROVED", draftAnswer: "Yes — UK and EU." },
    });
    expect((await res.json()).documentId).toBe("doc_1");
  });

  it("Dismiss closes the gap without creating knowledge", async () => {
    const res = await patch({ id: "rec_1", status: "DISMISSED" });
    expect(res.status).toBe(200);
    expect(mocks.upsertKnowledgeDocument).not.toHaveBeenCalled();
    expect(mocks.recUpdateMany.mock.calls[0]![0].data.status).toBe("DISMISSED");
  });
});

describe("POST /api/knowledge — Ask drafts", () => {
  const title = "Research draft — 12/11/2026";
  function saveDraft(content: string) {
    return createKnowledge(
      new NextRequest("http://localhost/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          category: "research",
          content,
          tags: ["draft", "from-ask"],
          status: "INACTIVE",
        }),
      }),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsertKnowledgeDocument.mockResolvedValue("doc_new");
    mocks.docUpdate.mockResolvedValue({});
  });

  it("a second same-day draft gets its own title instead of overwriting the first", async () => {
    mocks.docFindMany.mockResolvedValue([
      { id: "doc_1", title, content: "first answer" },
      { id: "doc_2", title: `${title} (2)`, content: "second answer" },
    ]);
    const res = await saveDraft("third answer");
    expect(res.status).toBe(200);
    expect(mocks.upsertKnowledgeDocument.mock.calls[0]![0].title).toBe(`${title} (3)`);
    // Ask drafts are still forced inactive.
    expect(mocks.docUpdate).toHaveBeenCalledWith({ where: { id: "doc_new" }, data: { status: "INACTIVE" } });
  });

  it("the first draft of the day keeps the plain title", async () => {
    mocks.docFindMany.mockResolvedValue([]);
    await saveDraft("first answer");
    expect(mocks.upsertKnowledgeDocument.mock.calls[0]![0].title).toBe(title);
  });

  it("re-saving identical content returns the existing draft untouched", async () => {
    mocks.docFindMany.mockResolvedValue([{ id: "doc_1", title, content: "same answer" }]);
    const res = await saveDraft("same answer");
    expect((await res.json()).id).toBe("doc_1");
    expect(mocks.upsertKnowledgeDocument).not.toHaveBeenCalled();
    expect(mocks.docUpdate).not.toHaveBeenCalled();
  });
});
