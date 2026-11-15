/**
 * Onboarding re-entry: Continue only writes answers that were actually sent with a value, so
 * the saved brand tone (or offering/audience/name) is never overwritten by defaults or blanks,
 * and GET returns the live saved values for pre-filling.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getOnboardingProgress: vi.fn(),
  setOnboardingProgress: vi.fn(),
  orgUpdate: vi.fn(),
  orgFindUnique: vi.fn(),
  agentUpdateMany: vi.fn(),
  agentFindFirst: vi.fn(),
  productFindFirst: vi.fn(),
  productCreate: vi.fn(),
  productUpdate: vi.fn(),
  audienceFindFirst: vi.fn(),
  audienceCreate: vi.fn(),
  audienceUpdate: vi.fn(),
  claimFindFirst: vi.fn(),
  claimCreate: vi.fn(),
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

vi.mock("@/services/social-connection-policy", () => ({
  getSocialConnectionPolicy: vi.fn(async () => ({
    socialConnectionsEnabled: true,
    maxConnectedSocialAccounts: 3,
    allowedNetworks: ["INSTAGRAM"],
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    organisation: {
      update: (...args: unknown[]) => mocks.orgUpdate(...args),
      findUnique: (...args: unknown[]) => mocks.orgFindUnique(...args),
    },
    agentConfiguration: {
      updateMany: (...args: unknown[]) => mocks.agentUpdateMany(...args),
      findFirst: (...args: unknown[]) => mocks.agentFindFirst(...args),
    },
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
      findFirst: (...args: unknown[]) => mocks.claimFindFirst(...args),
      create: (...args: unknown[]) => mocks.claimCreate(...args),
      update: vi.fn(),
    },
  },
}));

import { GET, POST } from "@/app/api/onboarding/progress/route";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/onboarding/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("onboarding re-entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOnboardingProgress.mockResolvedValue({
      completed: false,
      currentStep: 1,
      businessName: "Salon Demo",
      whatYouDo: "Hair and beauty treatments",
      agentBehaviour: "Warm, chatty and upbeat",
    });
    mocks.orgUpdate.mockResolvedValue({});
    mocks.agentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.productFindFirst.mockResolvedValue({ id: "prod_1" });
    mocks.audienceFindFirst.mockResolvedValue({ id: "aud_1" });
    mocks.claimFindFirst.mockResolvedValue(null);
    mocks.claimCreate.mockResolvedValue({});
  });

  it("Continue with only the step marker writes nothing to brand tone, name, offering or audience", async () => {
    const res = await post({ action: "save_progress", progress: { currentStep: 2 } });
    expect(res.status).toBe(200);
    expect(mocks.agentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
    expect(mocks.productUpdate).not.toHaveBeenCalled();
    expect(mocks.audienceUpdate).not.toHaveBeenCalled();
    const saved = mocks.setOnboardingProgress.mock.calls[0]![0].progress;
    expect(saved).toMatchObject({
      currentStep: 2,
      businessName: "Salon Demo",
      whatYouDo: "Hair and beauty treatments",
      agentBehaviour: "Warm, chatty and upbeat",
    });
  });

  it("blank answers never overwrite saved values", async () => {
    await post({
      action: "save_progress",
      progress: { currentStep: 2, businessName: "  ", whatYouDo: "", agentBehaviour: "   " },
    });
    expect(mocks.agentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
    expect(mocks.productUpdate).not.toHaveBeenCalled();
    const saved = mocks.setOnboardingProgress.mock.calls[0]![0].progress;
    expect(saved.businessName).toBe("Salon Demo");
    expect(saved.agentBehaviour).toBe("Warm, chatty and upbeat");
  });

  it("only the answer the user changed is written", async () => {
    await post({ action: "save_progress", progress: { currentStep: 4, agentBehaviour: "Calm and expert" } });
    expect(mocks.agentUpdateMany).toHaveBeenCalledWith({
      where: { organisationId: "org_a", isActive: true },
      data: { brandTone: "Calm and expert" },
    });
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
    expect(mocks.productUpdate).not.toHaveBeenCalled();
  });

  it("finishing without answers completes onboarding without touching saved values", async () => {
    const res = await post({ action: "complete", progress: { currentStep: 4 } });
    expect(res.status).toBe(200);
    expect(mocks.agentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.setOnboardingProgress.mock.calls[0]![0].progress.completed).toBe(true);
  });

  it("GET returns the live saved values for pre-filling (brand tone from the agent config)", async () => {
    mocks.orgFindUnique.mockResolvedValue({ name: "Salon Demo Ltd" });
    mocks.productFindFirst.mockResolvedValue({ description: "Cuts, colour and styling" });
    mocks.audienceFindFirst.mockResolvedValue({ description: null });
    mocks.agentFindFirst.mockResolvedValue({ brandTone: "Friendly and concise" });
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.saved).toEqual({
      businessName: "Salon Demo Ltd",
      whatYouDo: "Cuts, colour and styling",
      whoToReach: null,
      agentBehaviour: "Friendly and concise",
    });
    expect(mocks.productFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organisationId: "org_a", name: "Primary offering" } }),
    );
  });
});
