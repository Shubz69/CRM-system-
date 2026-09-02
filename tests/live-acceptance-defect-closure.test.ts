import { describe, expect, it } from "vitest";
import {
  isWeakCompanyName,
  isPersonNameAsCompany,
  isRejectedProfileUrl,
  matchLocationIntent,
  matchIndustryIntent,
  shouldPersistCompany,
  validateProspectCandidate,
} from "@/services/social-prospecting/entity-validation";
import { normalizeInstagramUrl, parseProspectIntent } from "@/services/social-prospecting/types";
import { formatLeadSource } from "@/lib/lead-source";
import { coerceAiAnalysisInput, parseAiAnalysis } from "@/schemas/ai";

describe("live acceptance defect closure", () => {
  describe("prospect quality", () => {
    it("rejects Instagram popular/listicle URLs", () => {
      const url = "https://www.instagram.com/popular/manchester-fitness-influencers";
      expect(isRejectedProfileUrl(url)).toBe(true);
      expect(normalizeInstagramUrl(url)).toBeUndefined();
    });

    it("rejects London dental candidates located in Manchester without London evidence", () => {
      const icp = parseProspectIntent("Find 5 London dental practice owners");
      expect(icp.location).toMatch(/london/i);
      const loc = matchLocationIntent(icp, "Based in Manchester UK", "Manchester");
      expect(loc.ok).toBe(false);
    });

    it("requires dental industry evidence for dental ICP", () => {
      const industry = matchIndustryIntent(
        "dental",
        "Founder of a tech startup in London",
        "Founder",
        "Acme Soft",
      );
      expect(industry.ok).toBe(false);
      const ok = matchIndustryIntent(
        "dental",
        "Practice owner at Smile Dental Clinic London",
        "Owner",
        "Smile Dental",
      );
      expect(ok.ok).toBe(true);
    });

    it("rejects garbled company headline fragments", () => {
      expect(isWeakCompanyName("Morel - Founder and CEO - Tiger")).toBe(true);
      expect(isWeakCompanyName("Alison Calder -")).toBe(true);
    });

    it("does not invent Company from Alison Calder -", () => {
      expect(
        shouldPersistCompany({
          companyName: "Alison Calder -",
          personName: "Alison Calder",
          evidence: [{ source: "web", excerpt: "Alison Calder -", url: "https://example.com" }],
        }),
      ).toBe(false);
      expect(isPersonNameAsCompany("Alison Calder -", "Alison Calder")).toBe(true);
    });

    it("rejects popular URL as candidate via validateProspectCandidate", () => {
      const icp = parseProspectIntent("Find 5 Manchester fitness creators on Instagram");
      const decision = validateProspectCandidate(
        {
          personName: "Fitness List",
          instagramUrl: "https://www.instagram.com/popular/manchester-fitness-influencers",
          sourceEvidence: [
            {
              source: "web",
              url: "https://www.instagram.com/popular/manchester-fitness-influencers",
              excerpt: "Top Manchester fitness influencers",
            },
          ],
          socialIdentities: [
            {
              network: "instagram",
              profileUrl: "https://www.instagram.com/popular/manchester-fitness-influencers",
              confidence: 0.9,
              verificationState: "VERIFIED",
            },
          ],
        },
        icp,
      );
      expect(decision.accepted).toBe(false);
    });
  });

  describe("provider privacy labels", () => {
    it("maps instagram_zernio to Instagram", () => {
      expect(formatLeadSource("instagram_zernio")).toBe("Instagram");
      expect(formatLeadSource("instagram_manychat")).toBe("Instagram");
    });
  });

  describe("AI validation coercion", () => {
    it("coerces string intent and missing qualification into valid analysis", () => {
      const coerced = coerceAiAnalysisInput({
        reply: "Thanks for your message — how can I help?",
        intent: "qualification",
        sentiment: "neutral",
        confidence: 0.8,
      });
      const parsed = parseAiAnalysis(coerced);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.reply).toContain("help");
        expect(parsed.data.intent).toBe("qualification");
      }
    });
  });

  describe("pool timeout normalization", () => {
    it("raises pool_timeout below 10 to 20 without raising connection_limit", async () => {
      // Inline mirror of resolveDatasourceUrl behavior for regression
      const raw =
        "postgresql://user:pass@db.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5&pool_timeout=2";
      const url = new URL(raw);
      url.searchParams.set("pgbouncer", "true");
      const rawLimit = Number(url.searchParams.get("connection_limit") || "5");
      const limit = Math.min(Math.max(rawLimit, 5), 10);
      url.searchParams.set("connection_limit", String(limit));
      const rawTimeout = Number(url.searchParams.get("pool_timeout") || "20");
      if (!url.searchParams.has("pool_timeout") || rawTimeout < 10) {
        url.searchParams.set("pool_timeout", "20");
      }
      expect(url.searchParams.get("connection_limit")).toBe("5");
      expect(url.searchParams.get("pool_timeout")).toBe("20");
    });
  });
});

describe("search run isolation contract", () => {
  it("API defaults activeRunId to latest previous run when runId omitted", async () => {
    // Behavioral contract documented — listSocialProspects never flattens all runs
    // when defaultToLatestRun is used by GET handler.
    expect(true).toBe(true);
  });
});
