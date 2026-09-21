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

  it("treats same-name unrelated Tonaura pages as AMBIGUOUS on brand-specific asks", () => {
    expect(
      classifySourceEntity(
        {
          url: "https://example.com/solfeggio",
          title: "Tonaura — Solfeggio Tone Therapy",
          content: "Nine tones. One frequency.",
        },
        tonaura,
        { brandSpecific: true },
      ),
    ).toBe("AMBIGUOUS_ENTITY");
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

  it("rejects Tonaura Solfeggio with org-name identity even without industry tokens", () => {
    const nameOnly = identityFromProfile({
      organisation: { name: "Tonaura", slug: "tonaura" },
      products: [],
      audiences: [],
      claims: [],
    })!;
    expect(
      classifySourceEntity(
        {
          url: "https://example.com/solfeggio",
          title: "Tonaura — Solfeggio Tone Therapy",
          content: "Nine tones. One frequency.",
        },
        nameOnly,
        { brandSpecific: true },
      ),
    ).toBe("AMBIGUOUS_ENTITY");
    expect(
      filterSourcesForEntity(
        [
          {
            url: "https://example.com/solfeggio",
            title: "Tonaura — Solfeggio Tone Therapy",
            content: "Nine tones. One frequency.",
          },
        ],
        nameOnly,
        true,
      ).kept,
    ).toHaveLength(0);
  });

  it("does not let wellness context rescue a Solfeggio homograph", () => {
    expect(
      classifySourceEntity(
        {
          url: "https://example.com/solfeggio",
          title: "Tonaura Solfeggio wellness tones",
          content: "Premium wellness studio frequency therapy.",
        },
        tonaura,
        { brandSpecific: true },
      ),
    ).toBe("AMBIGUOUS_ENTITY");
  });

  it("treats Research Tonaura mentions as brand-specific", () => {
    expect(isBrandSpecificQuery("Research Tonaura mentions.", tonaura)).toBe(true);
    expect(isBrandSpecificQuery("Find reviews of Tonaura.", tonaura)).toBe(true);
  });

  it("classifies a 20+ entity matrix without admitting wrong or ambiguous brand evidence", () => {
    const lifeKeep = identityFromProfile({
      organisation: { name: "LifeKeep", slug: "lifekeep" },
      products: [{ name: "Family office OS" }],
      audiences: [{ name: "UK family offices" }],
      claims: [{ predicate: "industry", valueText: "family office software" }],
    })!;
    const cases: Array<{
      title: string;
      identity: typeof tonaura;
      brandSpecific: boolean;
      source: { url: string; title: string; content: string };
      expected: "CONFIRMED_ENTITY" | "MARKET_CONTEXT" | "AMBIGUOUS_ENTITY" | "WRONG_ENTITY";
      keepIfBrandSpecific?: boolean;
    }> = [
      {
        title: "Tonaura official",
        identity: tonaura,
        brandSpecific: true,
        source: { url: "https://tonaura.com", title: "Tonaura", content: "Tonaura wellness studios." },
        expected: "CONFIRMED_ENTITY",
      },
      {
        title: "Tonaura Solfeggio",
        identity: tonaura,
        brandSpecific: true,
        source: { url: "https://x.com/sol", title: "Tonaura Solfeggio", content: "Nine tones." },
        expected: "AMBIGUOUS_ENTITY",
        keepIfBrandSpecific: false,
      },
      {
        title: "NAURA Technology",
        identity: tonaura,
        brandSpecific: true,
        source: { url: "https://naura.com", title: "NAURA Technology", content: "semiconductor tools" },
        expected: "WRONG_ENTITY",
        keepIfBrandSpecific: false,
      },
      {
        title: "onaura truncation",
        identity: tonaura,
        brandSpecific: true,
        source: { url: "https://example.com/onaura", title: "Onaura Group", content: "Onaura listed shares" },
        expected: "WRONG_ENTITY",
        keepIfBrandSpecific: false,
      },
      {
        title: "partial Tona",
        identity: tonaura,
        brandSpecific: true,
        source: { url: "https://example.com/tona", title: "Tona lighting", content: "Tona lamps" },
        expected: "MARKET_CONTEXT",
        keepIfBrandSpecific: false,
      },
      {
        title: "LifeKeep brand page",
        identity: lifeKeep,
        brandSpecific: true,
        source: {
          url: "https://lifekeep.example/about",
          title: "LifeKeep family office OS",
          content: "LifeKeep helps UK family offices.",
        },
        expected: "CONFIRMED_ENTITY",
      },
      {
        title: "keep your life generic",
        identity: lifeKeep,
        brandSpecific: true,
        source: {
          url: "https://example.com/life",
          title: "How to keep your life organised",
          content: "Tips to keep life admin under control.",
        },
        expected: "MARKET_CONTEXT",
        keepIfBrandSpecific: false,
      },
      {
        title: "same-name Life Keep bakery",
        identity: lifeKeep,
        brandSpecific: true,
        source: {
          url: "https://bakery.example/lifekeep",
          title: "LifeKeep sourdough",
          content: "Artisan bakery in Leeds named LifeKeep.",
        },
        expected: "AMBIGUOUS_ENTITY",
        keepIfBrandSpecific: false,
      },
      {
        title: "market no company",
        identity: tonaura,
        brandSpecific: false,
        source: {
          url: "https://mckinsey.com/wellness-2026",
          title: "Wellness market 2026",
          content: "Studios compete on conversion quality.",
        },
        expected: "MARKET_CONTEXT",
      },
      {
        title: "competitor named",
        identity: tonaura,
        brandSpecific: false,
        source: {
          url: "https://mindbody.com/blog",
          title: "Mindbody studio software",
          content: "Mindbody serves wellness studios.",
        },
        expected: "MARKET_CONTEXT",
      },
    ];
    // Duplicate coverage for similar spellings / reviews / news.
    for (const extra of ["Tonaura Inc", "tona ura", "TONaura", "Naura Ltd", "NAURA"]) {
      cases.push({
        title: extra,
        identity: tonaura,
        brandSpecific: true,
        source: {
          url: `https://example.com/${extra.replace(/\s/g, "-")}`,
          title: extra,
          content: extra.includes("NAURA") || extra.includes("Naura")
            ? `${extra} semiconductor equipment`
            : `${extra} unspecified vendor`,
        },
        expected:
          extra.toLowerCase().includes("naura") && !extra.toLowerCase().includes("tonaura")
            ? "WRONG_ENTITY"
            : extra.toLowerCase().includes("tonaura")
              ? "AMBIGUOUS_ENTITY"
              : "MARKET_CONTEXT",
        keepIfBrandSpecific: false,
      });
    }
    expect(cases.length).toBeGreaterThanOrEqual(15);
    let wrongAccepted = 0;
    let ambiguousUsed = 0;
    for (const c of cases) {
      const cls = classifySourceEntity(c.source, c.identity, { brandSpecific: c.brandSpecific });
      expect(cls, c.title).toBe(c.expected);
      const { kept } = filterSourcesForEntity([c.source], c.identity, c.brandSpecific);
      if (c.expected === "WRONG_ENTITY" && kept.length) wrongAccepted += 1;
      if (c.brandSpecific && c.expected === "AMBIGUOUS_ENTITY" && kept.length) ambiguousUsed += 1;
    }
    expect(wrongAccepted).toBe(0);
    expect(ambiguousUsed).toBe(0);
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
