/**
 * Adding a knowledge document whose title is already taken used to silently overwrite (and
 * reactivate) the existing document. Add now refuses with 409 unless the client explicitly asks
 * to replace it; editing by id keeps working; Ask drafts keep their "(2)" numbering.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  docFindFirst: vi.fn(),
  docFindMany: vi.fn(),
  docUpdate: vi.fn(),
  upsertKnowledgeDocument: vi.fn(),
  updateKnowledgeDocument: vi.fn(),
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
    knowledgeDocument: {
      findFirst: (...args: unknown[]) => mocks.docFindFirst(...args),
      findMany: (...args: unknown[]) => mocks.docFindMany(...args),
      update: (...args: unknown[]) => mocks.docUpdate(...args),
    },
  },
}));

vi.mock("@/services/knowledge", () => ({
  upsertKnowledgeDocument: (...args: unknown[]) => mocks.upsertKnowledgeDocument(...args),
  updateKnowledgeDocument: (...args: unknown[]) => mocks.updateKnowledgeDocument(...args),
  chunkText: (content: string) => (content ? [content] : []),
  archiveKnowledgeDocument: vi.fn(),
}));

import { PATCH, POST } from "@/app/api/knowledge/route";

function postJson(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function patchJson(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/knowledge", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const pricingDoc = { id: "doc_pricing", title: "Pricing", status: "ACTIVE" };

describe("POST /api/knowledge — duplicate titles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsertKnowledgeDocument.mockResolvedValue("doc_new");
    mocks.docFindMany.mockResolvedValue([]);
    mocks.docUpdate.mockResolvedValue({});
  });

  it("refuses to overwrite a document with the same title (409, nothing saved)", async () => {
    mocks.docFindFirst.mockResolvedValue(pricingDoc);
    const res = await postJson({ title: "Pricing", category: "pricing", content: "From £99" });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("DUPLICATE_TITLE");
    expect(json.existingId).toBe("doc_pricing");
    expect(json.error).toBe(
      'A document called "Pricing" already exists — open it to edit, or choose another title.',
    );
    expect(mocks.docFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organisationId: "org_a", title: { equals: "Pricing", mode: "insensitive" } },
      }),
    );
    expect(mocks.upsertKnowledgeDocument).not.toHaveBeenCalled();
    expect(mocks.docUpdate).not.toHaveBeenCalled();
  });

  it("also refuses when the existing document is inactive (no silent reactivation)", async () => {
    mocks.docFindFirst.mockResolvedValue({ ...pricingDoc, status: "INACTIVE" });
    const res = await postJson({ title: "Pricing", category: "pricing", content: "From £99" });
    expect(res.status).toBe(409);
    expect(mocks.upsertKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("replaces only when the client explicitly asks to", async () => {
    mocks.docFindFirst.mockResolvedValue(pricingDoc);
    const res = await postJson({
      title: "Pricing",
      category: "pricing",
      content: "From £99",
      replaceExisting: true,
    });
    expect(res.status).toBe(200);
    expect(mocks.upsertKnowledgeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ organisationId: "org_a", title: "Pricing", content: "From £99" }),
    );
  });

  it("a title that differs only in case or spacing is still a duplicate", async () => {
    mocks.docFindFirst.mockResolvedValue(pricingDoc);
    const res = await postJson({ title: "  pricing   ", category: "pricing", content: "From £99" });
    expect(res.status).toBe(409);
    expect(mocks.docFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organisationId: "org_a", title: { equals: "pricing", mode: "insensitive" } },
      }),
    );
    expect(mocks.upsertKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("replacing via a differently-cased title updates the existing document", async () => {
    mocks.docFindFirst.mockResolvedValue(pricingDoc);
    const res = await postJson({
      title: "PRICING",
      category: "pricing",
      content: "From £109",
      replaceExisting: true,
    });
    expect(res.status).toBe(200);
    // Saved under the stored title, so the existing document is the one replaced.
    expect(mocks.upsertKnowledgeDocument.mock.calls[0]![0].title).toBe("Pricing");
  });

  it("a blank title is refused", async () => {
    const res = await postJson({ title: "   ", category: "sop", content: "x" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Give the document a title.");
  });

  it("a new title saves normally", async () => {
    mocks.docFindFirst.mockResolvedValue(null);
    const res = await postJson({ title: "Refunds", category: "sop", content: "30 days" });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("doc_new");
    expect(mocks.upsertKnowledgeDocument.mock.calls[0]![0].title).toBe("Refunds");
  });

  it("Ask drafts keep their numbering and skip the duplicate check", async () => {
    const title = "Research draft — 12/11/2026";
    mocks.docFindMany.mockResolvedValue([{ id: "doc_1", title, content: "first" }]);
    const res = await postJson({
      title,
      category: "research",
      content: "second",
      tags: ["draft", "from-ask"],
      status: "INACTIVE",
    });
    expect(res.status).toBe(200);
    expect(mocks.docFindFirst).not.toHaveBeenCalled();
    expect(mocks.upsertKnowledgeDocument.mock.calls[0]![0].title).toBe(`${title} (2)`);
  });

  it("uploads with a taken title are refused too", async () => {
    mocks.docFindFirst.mockResolvedValue(pricingDoc);
    const form = new FormData();
    form.set("title", "Pricing");
    form.set("category", "upload");
    form.set("file", new File(["Our prices start at £99 a month for the starter plan."], "p.txt", { type: "text/plain" }));
    const res = await POST(new NextRequest("http://localhost/api/knowledge", { method: "POST", body: form }));
    expect(res.status).toBe(409);
    expect(mocks.upsertKnowledgeDocument).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/knowledge — editing keeps working", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.docUpdate.mockResolvedValue({});
  });

  const existing = { id: "doc_faq", title: "FAQ", content: "old", status: "ACTIVE" };

  it("edits a document by id (content change goes through updateKnowledgeDocument)", async () => {
    mocks.docFindFirst.mockResolvedValueOnce(existing);
    const res = await patchJson({ id: "doc_faq", title: "FAQ", content: "new", status: "ACTIVE" });
    expect(res.status).toBe(200);
    expect(mocks.updateKnowledgeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ id: "doc_faq", organisationId: "org_a", content: "new" }),
    );
  });

  it("renaming onto another document's title in a different case is refused", async () => {
    mocks.docFindFirst
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(pricingDoc);
    const res = await patchJson({ id: "doc_faq", title: "pricing " });
    expect(res.status).toBe(409);
    expect(mocks.docUpdate).not.toHaveBeenCalled();
  });

  it("changing only the case of a document's own title is allowed", async () => {
    mocks.docFindFirst
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(existing); // the clash lookup finds the same document
    const res = await patchJson({ id: "doc_faq", title: "faq" });
    expect(res.status).toBe(200);
    expect(mocks.docUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: "faq" }) }),
    );
  });

  it("renaming onto another document's title is refused", async () => {
    mocks.docFindFirst
      .mockResolvedValueOnce(existing) // the document being edited
      .mockResolvedValueOnce(pricingDoc); // the title clash
    const res = await patchJson({ id: "doc_faq", title: "Pricing" });
    expect(res.status).toBe(409);
    expect(mocks.docUpdate).not.toHaveBeenCalled();
    expect(mocks.updateKnowledgeDocument).not.toHaveBeenCalled();
  });
});
