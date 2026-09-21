import { describe, expect, it } from "vitest";
import {
  classifySourceEntity,
  expandResearchQueries,
  filterSourcesForEntity,
  identityFromProfile,
  isBrandSpecificQuery,
  likelyHomographs,
} from "@/lib/research-entity-resolution";
import { synthesiseResearchBrief } from "@/lib/research-visible-evidence";

describe("research entity resolution", () => {
  const tonaura = identityFromProfile({
    organisation: { name: "Tonaura", slug: "tonaura" },
    products: [{ name: "Wellness studio retainers" }],
    audiences: [{ name: "UK wellness studio founders" }],
    claims: [{ predicate: "industry", valueText: "premium wellness" }],
  })!;

  it("treats NAURA Technology as WRONG_ENTITY for Tonaura", () => {
    expect(likelyHomographs("Tonaura")).toContain("naura");
    expect(
      classifySourceEntity(
        {
          url: "https://example.com/naura",
          title: "What is Sales and Marketing Strategy of NAURA Technology GroupLtd",
          content: "NAURA Technology Group is a semiconductor equipment company.",
        },
        tonaura,
      ),
    ).toBe("WRONG_ENTITY");
  });

  it("keeps Tonaura domain and name as CONFIRMED_ENTITY", () => {
    expect(
      classifySourceEntity(
        {
          url: "https://tonaura.com/about",
          title: "Tonaura — calm conversion for wellness studios",
          content: "Tonaura helps founder-led studios.",
        },
        tonaura,
      ),
    ).toBe("CONFIRMED_ENTITY");
  });

  it("keeps general market sources that never mention the brand", () => {
    expect(
      classifySourceEntity(
        {
          url: "https://coursera.org/articles/business-trends-2026",
          title: "16 Business Trends for 2026",
          content: "Wellness and digital experience trends for SMEs.",
        },
        tonaura,
      ),
    ).toBe("MARKET_CONTEXT");
  });

  it("drops WRONG_ENTITY from market research but keeps MARKET_CONTEXT", () => {
    const { kept, droppedWrong } = filterSourcesForEntity(
      [
        {
          url: "https://example.com/naura",
          title: "NAURA Technology Group annual report",
          content: "NAURA ships semiconductor tools.",
        },
        {
          url: "https://businessnewsdaily.com/wellness",
          title: "Wellness studio conversion trends",
          content: "Calm landing pages outperform feature dumps.",
        },
      ],
      tonaura,
      false,
    );
    expect(droppedWrong).toHaveLength(1);
    expect(kept.map((s) => s.url)).toEqual(["https://businessnewsdaily.com/wellness"]);
  });

  it("does not treat LifeKeep generic two-word copy as confirmed for brand-specific asks", () => {
    const lifeKeep = identityFromProfile({
      organisation: { name: "LifeKeep", slug: "lifekeep" },
      products: [],
      audiences: [{ name: "UK family office managers" }],
      claims: [],
    })!;
    expect(isBrandSpecificQuery("What are people saying about LifeKeep?", lifeKeep)).toBe(true);
    expect(isBrandSpecificQuery("Research family-office admin trends relevant to LifeKeep", lifeKeep)).toBe(
      false,
    );
    const generic = classifySourceEntity(
      {
        url: "https://example.com/keep-your-life",
        title: "How to keep your life organised",
        content: "Tips to keep life admin under control.",
      },
      lifeKeep,
    );
    expect(generic).toBe("MARKET_CONTEXT");
  });

  it("adds homograph exclusions to expanded queries", () => {
    const queries = expandResearchQueries(
      "Research the latest trends relevant to Tonaura.",
      tonaura,
      4,
    );
    expect(queries.some((q) => /-naura/i.test(q))).toBe(true);
    expect(queries.some((q) => /wellness/i.test(q))).toBe(true);
  });
});

describe("synthesiseResearchBrief", () => {
  it("returns a decision-ready structure without inventing stats", () => {
    const brief = synthesiseResearchBrief({
      topic: "Research the latest trends relevant to Tonaura.",
      businessName: "Tonaura",
      audience: "UK wellness studio founders",
      sources: [
        {
          url: "https://coursera.org/trends",
          title: "16 Business Trends for 2026",
          content: "Digital experience quality is a buying filter.",
        },
      ],
      findings: [
        {
          claim: "Digital experience quality is a buying filter — 16 Business Trends for 2026",
          sourceUrl: "https://coursera.org/trends",
        },
      ],
    });
    expect(brief).toMatch(/DIRECT ANSWER/);
    expect(brief).toMatch(/KEY FINDINGS/);
    expect(brief).toMatch(/WHAT THIS MEANS FOR Tonaura/);
    expect(brief).toMatch(/RECOMMENDED ACTIONS/);
    expect(brief).not.toMatch(/\b(tavily|exa|anthropic)\b/i);
    expect(brief).not.toMatch(/\b\d{2,}%\b/);
  });
});
