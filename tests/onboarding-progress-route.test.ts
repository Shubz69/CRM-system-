/**
 * Onboarding progress: repeated saves upsert the primary offering/audience (no duplicates) and
 * skipping connections completes onboarding.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getOnboardingProgress: vi.fn(),
  setOnboardingProgress: vi.fn(),
  productFindFirst: vi.fn(),
  productCreate: vi.fn(),
  productUpdate: vi.fn(),
  audienceFindFirst: vi.fn(),
  audienceCreate: vi.fn(),
  audienceUpdate: vi.fn(),
  orgUpdate: vi.fn(),
  agentUpdateMany: vi.fn(),
  businessClaimFindFirst: vi.fn(),
  businessClaimCreate: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requirePermission: vi.fn(async () => ({ organisationId: "org_a", userId: "u1" })),
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));

vi.mock("@/services/beta-workspace", () => ({
  getOnboardingProgress: (...args: unknown[]) => mocks.getOnboardingProgress(...args),
  setOnboardingProgress: (...args: unknown[]) => mocks.setOnboardingProgress(...args),
}));

vi.mock("@/services/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    organisation: { update: (...args: unknown[]) => mocks.orgUpdate(...args) },
    agentConfiguration: { updateMany: (...args: unknown[]) => mocks.agentUpdateMany(...args) },
    productOffering: {
      findFirst: (...args: unknown[]) => mocks.productFindFirst(...args),
      create: (...args: unknown[]) => mocks.productCreate(...args),
      update: (...args: unknown[]) => mocks.productUpdate(...args),
    },
    audienceSegment: {
      findFirst: (...args: unknown[]) => mocks.audienceFindFirst(...args),
      create: (...args: unknown[]) => mocks.audienceCreate(...args),
      update: (...args: unknown[]) => mocks.audienceUpdate(...args),
    },
    businessClaim: {
      findFirst: (...args: unknown[]) => mocks.businessClaimFindFirst(...args),
      create: (...args: unknown[]) => mocks.businessClaimCreate(...args),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { POST } from "@/app/api/onboarding/progress/route";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/onboarding/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const progress = {
  currentStep: 2,
  businessName: "Acme",
  whatYouDo: "AI automation for UK SMEs",
  whoToReach: "Owners of 10-50 person firms",
};

describe("POST /api/onboarding/progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOnboardingProgress.mockResolvedValue({ completed: false, currentStep: 0 });
    mocks.orgUpdate.mockResolvedValue({});
    mocks.agentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.businessClaimFindFirst.mockResolvedValue(null);
    mocks.businessClaimCreate.mockResolvedValue({});
  });

  it("updates the existing Primary offering / audience instead of creating duplicates", async () => {
    mocks.productFindFirst.mockResolvedValue({ id: "prod_1" });
    mocks.audienceFindFirst.mockResolvedValue({ id: "aud_1" });
    for (let i = 0; i < 2; i++) {
      const res = await post({ action: "save_progress", progress });
      expect(res.status).toBe(200);
    }
    expect(mocks.productCreate).not.toHaveBeenCalled();
    expect(mocks.audienceCreate).not.toHaveBeenCalled();
    expect(mocks.productFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organisationId: "org_a", name: "Primary offering" } }),
    );
    expect(mocks.productUpdate).toHaveBeenCalledWith({
      where: { id: "prod_1" },
      data: { description: "AI automation for UK SMEs" },
    });
    expect(mocks.audienceUpdate).toHaveBeenCalledWith({
      where: { id: "aud_1" },
      data: { description: "Owners of 10-50 person firms" },
    });
  });

  it("creates the Primary offering / audience only when none exists", async () => {
    mocks.productFindFirst.mockResolvedValue(null);
    mocks.audienceFindFirst.mockResolvedValue(null);
    await post({ action: "complete", progress });
    expect(mocks.productCreate).toHaveBeenCalledTimes(1);
    expect(mocks.audienceCreate).toHaveBeenCalledTimes(1);
    expect(mocks.productUpdate).not.toHaveBeenCalled();
  });

  it("skip_connections marks onboarding completed and saves the business context", async () => {
    mocks.productFindFirst.mockResolvedValue({ id: "prod_1" });
    mocks.audienceFindFirst.mockResolvedValue({ id: "aud_1" });
    const res = await post({ action: "skip_connections", progress: { ...progress, skippedConnections: true } });
    expect(res.status).toBe(200);
    const saved = mocks.setOnboardingProgress.mock.calls[0]![0].progress;
    expect(saved.completed).toBe(true);
    expect(saved.skippedConnections).toBe(true);
    expect(typeof saved.completedAt).toBe("string");
    expect(mocks.productUpdate).toHaveBeenCalled();
    expect((await res.json()).progress.completed).toBe(true);
  });
});
