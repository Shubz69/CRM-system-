import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUniqueSnapshot: vi.fn(),
  upsertSnapshot: vi.fn(),
  findUniqueDefinition: vi.fn(),
  createTransition: vi.fn(),
  createEvidenceLinks: vi.fn(),
  findManySnapshots: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const client = {
    stateSnapshot: {
      findUnique: mocks.findUniqueSnapshot,
      upsert: mocks.upsertSnapshot,
      findMany: mocks.findManySnapshots,
    },
    stateDefinition: { findUnique: mocks.findUniqueDefinition },
    stateTransition: { create: mocks.createTransition },
    stateEvidenceLink: { createMany: mocks.createEvidenceLinks },
  };
  return {
    prisma: {
      ...client,
      $transaction: vi.fn(async (callback: (tx: typeof client) => unknown) => callback(client)),
    },
  };
});

import {
  applyStateUpdate,
  listStateSnapshots,
} from "@/services/business-state";

describe("business state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUniqueDefinition.mockResolvedValue({ id: "definition-1" });
  });

  it("does not create a transition when the value is unchanged", async () => {
    mocks.findUniqueSnapshot.mockResolvedValue({
      id: "snapshot-1",
      organisationId: "org-a",
      value: "HIGH",
    });

    const result = await applyStateUpdate({
      organisationId: "org-a",
      entityType: "deal",
      entityId: "deal-1",
      dimension: "risk",
      value: "high",
    });

    expect(result.changed).toBe(false);
    expect(mocks.upsertSnapshot).not.toHaveBeenCalled();
    expect(mocks.createTransition).not.toHaveBeenCalled();
  });

  it("creates a transition for a material value change", async () => {
    mocks.findUniqueSnapshot.mockResolvedValue({
      id: "snapshot-1",
      organisationId: "org-a",
      value: "LOW",
    });
    mocks.upsertSnapshot.mockResolvedValue({
      id: "snapshot-1",
      organisationId: "org-a",
      value: "HIGH",
    });
    mocks.createTransition.mockResolvedValue({ id: "transition-1" });

    const result = await applyStateUpdate({
      organisationId: "org-a",
      entityType: "DEAL",
      entityId: "deal-1",
      dimension: "RISK",
      value: "HIGH",
      evidenceLinks: [{ evidenceKind: "CRM_ACTIVITY", evidenceId: "activity-1" }],
    });

    expect(result.changed).toBe(true);
    expect(mocks.createTransition).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organisationId: "org-a",
        fromValue: "LOW",
        toValue: "HIGH",
      }),
    });
    expect(mocks.createEvidenceLinks).toHaveBeenCalledOnce();
  });

  it("always scopes snapshot reads to the requested organisation", async () => {
    mocks.findManySnapshots.mockResolvedValue([]);
    await listStateSnapshots("org-b", { entityType: "deal", entityId: "deal-1" });

    expect(mocks.findManySnapshots).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organisationId: "org-b",
          entityId: "deal-1",
        }),
      }),
    );
  });
});
