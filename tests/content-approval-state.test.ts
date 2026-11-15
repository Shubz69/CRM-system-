/**
 * Content approval state machine: draft → in review → approved / sent back. A draft can't be
 * approved without being submitted, editing approved copy sends it back to drafts, and every
 * transition is a conditional update so two people acting at once can't both win.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  contentPiece: { findFirst: vi.fn(), updateMany: vi.fn() },
  contentApproval: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  contentVersion: { findFirst: vi.fn(), create: vi.fn() },
  publishingJob: { count: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));

import {
  ContentStateError,
  decidePieceApproval,
  submitPieceForApproval,
  updatePiece,
} from "@/services/content-os";

const why = { rationale: "Manual draft created in Content OS", operatorDraft: true };

function piece(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "piece_1",
    organisationId: "org_1",
    title: "Spring launch",
    body: "Our new menu is here",
    platform: "instagram",
    status,
    whyEvidence: why,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.contentPiece.updateMany.mockResolvedValue({ count: 1 });
  db.contentApproval.create.mockResolvedValue({ id: "appr_new" });
  db.contentApproval.updateMany.mockResolvedValue({ count: 1 });
  db.contentVersion.findFirst.mockResolvedValue({ version: 1 });
  db.contentVersion.create.mockResolvedValue({});
  db.publishingJob.count.mockResolvedValue(0);
});

describe("decidePieceApproval", () => {
  it("refuses to approve a draft that was never submitted", async () => {
    db.contentPiece.findFirst.mockResolvedValue(piece("DRAFT"));
    await expect(
      decidePieceApproval({ organisationId: "org_1", pieceId: "piece_1", decision: "APPROVED" }),
    ).rejects.toThrow(ContentStateError);
    await expect(
      decidePieceApproval({ organisationId: "org_1", pieceId: "piece_1", decision: "APPROVED" }),
    ).rejects.toThrow(/Submit this piece for approval/);
    expect(db.contentPiece.updateMany).not.toHaveBeenCalled();
    expect(db.contentApproval.create).not.toHaveBeenCalled();
  });

  it("refuses to re-approve an approved piece", async () => {
    db.contentPiece.findFirst.mockResolvedValue(piece("APPROVED"));
    await expect(
      decidePieceApproval({ organisationId: "org_1", pieceId: "piece_1", decision: "APPROVED" }),
    ).rejects.toThrow(/already been approved/);
  });

  it("approves a piece in review and closes its pending request", async () => {
    db.contentPiece.findFirst.mockResolvedValue(piece("IN_REVIEW"));
    await decidePieceApproval({
      organisationId: "org_1",
      pieceId: "piece_1",
      decision: "APPROVED",
      decidedByUserId: "mgr_1",
    });
    expect(db.contentPiece.updateMany).toHaveBeenCalledWith({
      where: { id: "piece_1", organisationId: "org_1", status: "IN_REVIEW" },
      data: { status: "APPROVED" },
    });
    expect(db.contentApproval.updateMany).toHaveBeenCalledWith({
      where: { organisationId: "org_1", pieceId: "piece_1", decision: "PENDING" },
      data: expect.objectContaining({ decision: "APPROVED", decidedByUserId: "mgr_1" }),
    });
    expect(db.contentApproval.create).not.toHaveBeenCalled();
  });

  it("sending back returns the piece to drafts", async () => {
    db.contentPiece.findFirst.mockResolvedValue(piece("IN_REVIEW"));
    await decidePieceApproval({ organisationId: "org_1", pieceId: "piece_1", decision: "REJECTED" });
    expect(db.contentPiece.updateMany.mock.calls[0]![0].data).toEqual({ status: "DRAFT" });
  });

  it("only one of two simultaneous decisions wins", async () => {
    db.contentPiece.findFirst.mockResolvedValue(piece("IN_REVIEW"));
    db.contentPiece.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      decidePieceApproval({ organisationId: "org_1", pieceId: "piece_1", decision: "APPROVED" }),
    ).rejects.toThrow(/already decided/);
    expect(db.contentApproval.updateMany).not.toHaveBeenCalled();
  });
});

describe("submitPieceForApproval", () => {
  it("moves a draft into review and opens a pending request", async () => {
    db.contentPiece.findFirst.mockResolvedValue(piece("DRAFT"));
    const id = await submitPieceForApproval({ organisationId: "org_1", pieceId: "piece_1" });
    expect(id).toBe("appr_new");
    expect(db.contentPiece.updateMany).toHaveBeenCalledWith({
      where: { id: "piece_1", organisationId: "org_1", status: { in: ["DRAFT", "FAILED"] } },
      data: { status: "IN_REVIEW" },
    });
    expect(db.contentApproval.create).toHaveBeenCalledWith({
      data: { organisationId: "org_1", pieceId: "piece_1", decision: "PENDING" },
    });
  });

  it("submitting twice reuses the pending request", async () => {
    db.contentPiece.findFirst.mockResolvedValue(piece("IN_REVIEW"));
    db.contentApproval.findFirst.mockResolvedValue({ id: "appr_pending" });
    const id = await submitPieceForApproval({ organisationId: "org_1", pieceId: "piece_1" });
    expect(id).toBe("appr_pending");
    expect(db.contentPiece.updateMany).not.toHaveBeenCalled();
    expect(db.contentApproval.create).not.toHaveBeenCalled();
  });

  it.each([
    ["APPROVED", /already approved/],
    ["PUBLISHED", /already been published/],
    ["ARCHIVED", /Archived/],
  ])("refuses to submit a %s piece", async (status, message) => {
    db.contentPiece.findFirst.mockResolvedValue(piece(status));
    await expect(
      submitPieceForApproval({ organisationId: "org_1", pieceId: "piece_1" }),
    ).rejects.toThrow(message);
    expect(db.contentPiece.updateMany).not.toHaveBeenCalled();
  });
});

describe("updatePiece", () => {
  it("editing approved copy sends it back to drafts for re-approval", async () => {
    db.contentPiece.findFirst.mockResolvedValue(piece("APPROVED"));
    const result = await updatePiece({
      organisationId: "org_1",
      pieceId: "piece_1",
      body: "Our new menu is here — now with vegan options",
    });
    expect(result).toEqual({ status: "DRAFT", changed: true });
    expect(db.contentPiece.updateMany).toHaveBeenCalledWith({
      where: { id: "piece_1", organisationId: "org_1", status: "APPROVED" },
      data: expect.objectContaining({
        status: "DRAFT",
        body: "Our new menu is here — now with vegan options",
      }),
    });
    expect(db.contentVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 2, pieceId: "piece_1" }),
    });
  });

  it("refuses to edit approved copy that is already queued to publish", async () => {
    db.contentPiece.findFirst.mockResolvedValue(piece("SCHEDULED"));
    db.publishingJob.count.mockResolvedValueOnce(1);
    await expect(
      updatePiece({ organisationId: "org_1", pieceId: "piece_1", title: "New title" }),
    ).rejects.toThrow(/Cancel its publish job/);
    expect(db.publishingJob.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ organisationId: "org_1", pieceId: "piece_1" }),
    });
    expect(db.contentPiece.updateMany).not.toHaveBeenCalled();
  });

  it("a save with no real change leaves the status alone", async () => {
    db.contentPiece.findFirst.mockResolvedValue(piece("APPROVED"));
    const result = await updatePiece({
      organisationId: "org_1",
      pieceId: "piece_1",
      title: "Spring launch",
      body: "Our new menu is here",
    });
    expect(result).toEqual({ status: "APPROVED", changed: false });
    expect(db.contentPiece.updateMany).not.toHaveBeenCalled();
  });

  it("drafts and pieces in review keep their status when edited", async () => {
    db.contentPiece.findFirst.mockResolvedValue(piece("IN_REVIEW"));
    const result = await updatePiece({ organisationId: "org_1", pieceId: "piece_1", title: "Spring menu" });
    expect(result.status).toBe("IN_REVIEW");
    expect(db.contentPiece.updateMany.mock.calls[0]![0].data.status).toBe("IN_REVIEW");
  });

  it("published pieces can't be edited", async () => {
    db.contentPiece.findFirst.mockResolvedValue(piece("PUBLISHED"));
    await expect(
      updatePiece({ organisationId: "org_1", pieceId: "piece_1", title: "x" }),
    ).rejects.toThrow(ContentStateError);
  });
});
