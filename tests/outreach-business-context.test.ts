/**
 * Outreach drafts used to pitch "AI operations" for every workspace. They now speak for the
 * workspace's own business profile (name, offer, audience, tone) and stay neutral without one.
 * Also: Growth/Opportunities status labels and open-only counts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  businessClaim: { findFirst: vi.fn() },
  productOffering: { findFirst: vi.fn(), findMany: vi.fn() },
  audienceSegment: { findMany: vi.fn() },
  agentConfiguration: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));

import {
  generateOutreachDrafts,
  loadOutreachBusinessContext,
} from "@/services/social-prospecting/outreach";
import {
  countOpenOpportunities,
  opportunityStatusLabel,
} from "@/app/(app)/opportunities/opportunity-status";

const prospect = {
  personName: "Ada Lovelace",
  companyName: "Analytical Engines",
  role: "Founder",
  location: "London",
  evidenceExcerpts: ["Analytical Engines opened a second studio in 2026"],
  evidenceConfidence: 0.85,
};

describe("generateOutreachDrafts — business context", () => {
  it("introduces the workspace's business, offer and audience", () => {
    const drafts = generateOutreachDrafts({
      ...prospect,
      businessName: "Bloom & Co",
      offerSummary: "Custom wedding flowers",
      audience: "Couples planning a summer wedding",
      brandTone: "warm and friendly",
      email: "ada@example.com",
    });
    expect(drafts.connectionNote).toMatch(/I'm with Bloom & Co/);
    expect(drafts.connectionNote).toMatch(/couples planning a summer wedding/);
    expect(drafts.connectionNote).toMatch(/custom wedding flowers/);
    expect(drafts.connectionNote.length).toBeLessThanOrEqual(280);
    expect(drafts.connectionNote).toMatch(/^Hey Ada/); // friendly tone
    expect(drafts.instagramMessage).toMatch(/Bloom & Co/);
    expect(drafts.genericSocialOutreach).toMatch(/Bloom & Co/);
    expect(drafts.emailDraft).toMatch(/Cheers,\nBloom & Co$/);
    expect(JSON.stringify(drafts)).not.toMatch(/AI operations/);
  });

  it("uses an offer written as a sentence as a sentence", () => {
    const drafts = generateOutreachDrafts({
      ...prospect,
      businessName: "Crumb Bakery",
      offerSummary: "We bake custom celebration cakes for local events.",
    });
    expect(drafts.connectionNote).toMatch(/I'm with Crumb Bakery\. We bake custom celebration cakes for local events\./);
    expect(drafts.connectionNote).toMatch(/short note on what we do\./);
    expect(drafts.connectionNote).not.toMatch(/note on we bake/i);
  });

  it("without a profile the copy stays neutral (no invented pitch)", () => {
    const drafts = generateOutreachDrafts({ ...prospect });
    const all = JSON.stringify(drafts);
    expect(all).not.toMatch(/AI operations/);
    expect(all).not.toMatch(/I'm with/);
    expect(drafts.connectionNote).toMatch(/^Hi Ada/);
    expect(drafts.connectionNote).toMatch(/what we do/);
  });

  it("drops optional detail rather than cutting a long note mid-sentence", () => {
    const drafts = generateOutreachDrafts({
      ...prospect,
      businessName: "An Exceptionally Long Business Name Limited",
      offerSummary: "End-to-end bespoke bridal styling, tailoring and on-the-day coordination services",
      audience: "Brides and grooms across the whole of the South East of England and beyond",
      observedPostExcerpt: "We just opened our flagship atelier on the high street with a huge launch party for everyone",
    });
    expect(drafts.connectionNote.length).toBeLessThanOrEqual(280);
    expect(drafts.connectionNote.endsWith(".")).toBe(true);
  });
});

describe("sentence endings", () => {
  it("evidence that already ends a sentence doesn't get a second full stop", () => {
    const drafts = generateOutreachDrafts({
      ...prospect,
      evidenceExcerpts: ["Analytical Engines opened a second studio this autumn."],
      businessName: "Glow Salon",
      email: "ada@example.com",
    });
    for (const text of [drafts.connectionNote, drafts.instagramMessage, drafts.emailDraft ?? ""]) {
      expect(text).not.toMatch(/\.\./);
    }
    expect(drafts.connectionNote).toMatch(/this autumn\. I'm with Glow Salon/);
  });
});

describe("loadOutreachBusinessContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.organisation.findUnique.mockResolvedValue({ name: "Bloom & Co" });
    db.businessClaim.findFirst.mockResolvedValue({ valueText: "Flowers (from onboarding)" });
    db.productOffering.findFirst.mockResolvedValue({ description: "Custom wedding flowers." });
    db.productOffering.findMany.mockResolvedValue([
      { name: "Primary offering", description: "Custom wedding flowers.", targetAudience: null },
    ]);
    db.audienceSegment.findMany.mockResolvedValue([
      { name: "Primary audience", description: "Couples planning a summer wedding" },
    ]);
    db.agentConfiguration.findFirst.mockResolvedValue({ brandTone: "warm, friendly" });
  });

  it("reads the org-scoped business profile", async () => {
    const ctx = await loadOutreachBusinessContext("org_1");
    expect(ctx).toEqual({
      businessName: "Bloom & Co",
      offerSummary: "Custom wedding flowers",
      audience: "Couples planning a summer wedding",
      brandTone: "warm, friendly",
    });
    expect(db.organisation.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "org_1" } }));
    for (const fn of [db.businessClaim.findFirst, db.productOffering.findFirst, db.productOffering.findMany, db.audienceSegment.findMany, db.agentConfiguration.findFirst]) {
      expect((fn.mock.calls[0] as unknown as [{ where: { organisationId: string } }])[0].where.organisationId).toBe("org_1");
    }
  });

  it("falls back to the onboarding claim, then product names", async () => {
    db.productOffering.findFirst.mockResolvedValue(null);
    expect((await loadOutreachBusinessContext("org_1")).offerSummary).toBe("Flowers (from onboarding)");
    db.businessClaim.findFirst.mockResolvedValue(null);
    db.productOffering.findMany.mockResolvedValue([
      { name: "Bridal bouquets", description: null, targetAudience: "Brides" },
      { name: "Table centrepieces", description: null, targetAudience: null },
    ]);
    db.audienceSegment.findMany.mockResolvedValue([]);
    const ctx = await loadOutreachBusinessContext("org_1");
    expect(ctx.offerSummary).toBe("Bridal bouquets and Table centrepieces");
    expect(ctx.audience).toBe("Brides");
  });

  it("names each product once, even when the profile lists it twice", async () => {
    db.productOffering.findFirst.mockResolvedValue(null);
    db.businessClaim.findFirst.mockResolvedValue(null);
    db.productOffering.findMany.mockResolvedValue([
      { name: "Balayage colour", description: null, targetAudience: null },
      { name: "balayage colour ", description: null, targetAudience: null },
      { name: "Gloss treatment", description: null, targetAudience: null },
    ]);
    const ctx = await loadOutreachBusinessContext("org_1");
    expect(ctx.offerSummary).toBe("Balayage colour and Gloss treatment");
  });

  it("never throws — a broken lookup just means neutral copy", async () => {
    db.organisation.findUnique.mockImplementation(() => {
      throw new Error("db down");
    });
    expect(await loadOutreachBusinessContext("org_1")).toEqual({
      businessName: null,
      offerSummary: null,
      audience: null,
      brandTone: null,
    });
  });
});

describe("opportunity statuses (Growth / Opportunities)", () => {
  it("a dismissed opportunity is labelled Dismissed, not Needs attention", () => {
    expect(opportunityStatusLabel("REJECTED")).toBe("Dismissed");
    expect(opportunityStatusLabel("DISMISSED")).toBe("Dismissed");
    expect(opportunityStatusLabel("DETECTED")).toBe("New");
    expect(opportunityStatusLabel("IN_PROGRESS")).toBe("In progress");
    expect(opportunityStatusLabel("EXPIRED")).toBe("Expired");
  });

  it("the Growth overview counts open opportunities only", () => {
    expect(
      countOpenOpportunities([
        { status: "DETECTED" },
        { status: "REVIEWED" },
        { status: "ACCEPTED" },
        { status: "IN_PROGRESS" },
        { status: "REJECTED" },
        { status: "DISMISSED" },
        { status: "EXPIRED" },
        { status: "COMPLETED" },
      ]),
    ).toBe(4);
  });
});
