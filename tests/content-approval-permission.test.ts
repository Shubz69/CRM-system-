/**
 * Approving content is a manager decision (automations:manage — the Approvals queue permission).
 * Sales agents and analysts can draft and submit, but approve / send back is 403 for them.
 * State-machine refusals come back as 409 with a plain message.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  role: "OWNER" as string,
  decidePieceApproval: vi.fn(),
  submitPieceForApproval: vi.fn(),
  updatePiece: vi.fn(),
}));

vi.mock("@/lib/session", () => {
  class WorkspaceChangedError extends Error {}
  const session = () => ({ organisationId: "org_1", userId: "u1", role: mocks.role });
  return {
    requirePermission: vi.fn(async () => session()),
    requirePermissionForMutation: vi.fn(async () => session()),
    jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
    WorkspaceChangedError,
    workspaceChangedJsonResponse: () => Response.json({ error: "changed" }, { status: 409 }),
  };
});

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/org-rate-limit", () => ({
  assertOrgExpensiveRouteAllowed: vi.fn(),
  OrgRateLimitError: class OrgRateLimitError extends Error {},
}));
vi.mock("@/services/publishing/publish-targets", () => ({ listPublishTargets: vi.fn(async () => []) }));
vi.mock("@/services/publishing", () => ({ cancelPublishingJob: vi.fn() }));
vi.mock("@/services/content-os", () => {
  class ContentStateError extends Error {
    readonly code = "CONTENT_STATE";
  }
  return {
    ContentStateError,
    createBriefAndPiece: vi.fn(),
    createDraftPiece: vi.fn(),
    createIdeaFromOpportunity: vi.fn(),
    createOpportunityFromResearch: vi.fn(),
    decidePieceApproval: (...args: unknown[]) => mocks.decidePieceApproval(...args),
    requestPublish: vi.fn(),
    submitPieceForApproval: (...args: unknown[]) => mocks.submitPieceForApproval(...args),
    updatePiece: (...args: unknown[]) => mocks.updatePiece(...args),
  };
});

import { POST } from "@/app/api/content/route";
import { ContentStateError } from "@/services/content-os";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/content — who may approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decidePieceApproval.mockResolvedValue(undefined);
    mocks.submitPieceForApproval.mockResolvedValue("appr_1");
  });

  it.each(["SALES_AGENT", "ANALYST"])("%s cannot approve or send back (403)", async (role) => {
    mocks.role = role;
    for (const decision of ["APPROVED", "REJECTED"]) {
      const res = await post({ action: "decide_approval", pieceId: "piece_1", decision });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/owner, administrator or manager/i);
    }
    expect(mocks.decidePieceApproval).not.toHaveBeenCalled();
  });

  it("a sales agent can still submit a piece for approval", async () => {
    mocks.role = "SALES_AGENT";
    const res = await post({ action: "submit_approval", pieceId: "piece_1" });
    expect(res.status).toBe(200);
    expect(mocks.submitPieceForApproval).toHaveBeenCalled();
  });

  it.each(["OWNER", "ADMINISTRATOR", "MANAGER"])("%s can approve", async (role) => {
    mocks.role = role;
    const res = await post({ action: "decide_approval", pieceId: "piece_1", decision: "APPROVED" });
    expect(res.status).toBe(200);
    expect(mocks.decidePieceApproval).toHaveBeenCalledWith(
      expect.objectContaining({ organisationId: "org_1", pieceId: "piece_1", decision: "APPROVED", decidedByUserId: "u1" }),
    );
  });

  it("approving a piece that skipped review is a 409 with the reason", async () => {
    mocks.role = "OWNER";
    mocks.decidePieceApproval.mockRejectedValueOnce(
      new ContentStateError("Submit this piece for approval before approving or sending it back."),
    );
    const res = await post({ action: "decide_approval", pieceId: "piece_1", decision: "APPROVED" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Submit this piece for approval/);
  });

  it("editing reports where the piece ended up", async () => {
    mocks.role = "SALES_AGENT";
    mocks.updatePiece.mockResolvedValueOnce({ status: "DRAFT", changed: true });
    const res = await post({ action: "update_piece", pieceId: "piece_1", body: "New copy" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "DRAFT", changed: true });
  });
});
