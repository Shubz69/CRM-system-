import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AnswerModeOutputView } from "@/components/ask/answer-mode-output";
import { ASK_SHOW_SOURCES_BY_DEFAULT } from "@/lib/ask-result-ui";
import { shapeFinalOutputForMode } from "@/services/answer-modes/shape";

const SAMPLE = {
  researchJobId: "rj_ui",
  topic: "Instagram Reels growth",
  summary: "Post 4–6 Reels a week with a spoken hook in the first 3 seconds.",
  claims: [
    {
      claim: "Weekly Reel cadence beats sporadic posting.",
      sourceUrl: "https://example.com/reels-playbook",
      evidenceExcerpt: "4–6 Reels a week",
    },
  ],
  findings: [
    {
      claim: "Weekly Reel cadence beats sporadic posting.",
      sourceUrl: "https://example.com/reels-playbook",
      evidenceExcerpt: "4–6 Reels a week",
      sourceTitle: "Reels playbook",
    },
  ],
  sources: [
    {
      url: "https://example.com/reels-playbook",
      title: "Reels playbook 2026",
      snippet: "4–6 Reels a week",
      platform: "web",
    },
  ],
  contentHooks: ["Hook: Stop posting random carousels."],
};

describe("Ask result UI — four sections, sources off by default", () => {
  it("renders Strategy, Scripts, Posting plan, Monetization and no source list", () => {
    expect(ASK_SHOW_SOURCES_BY_DEFAULT).toBe(false);
    const output = shapeFinalOutputForMode(
      "QUICK",
      SAMPLE,
      "What Instagram Reels content and posting strategy should I use to grow?",
    );
    const html = renderToStaticMarkup(
      createElement(AnswerModeOutputView, {
        output,
        request: "What Instagram Reels content and posting strategy should I use to grow?",
        fallback: createElement("div", null, "legacy"),
      }),
    );

    expect(html).toContain("Strategy");
    expect(html).toContain("Scripts");
    expect(html).toContain("Posting plan");
    expect(html).toContain("Monetization");
    expect(html).toContain('data-testid="ask-typed-answers"');
    expect(html).not.toContain("Sources (");
    expect(html).not.toContain("https://example.com/reels-playbook");
    expect(html).not.toMatch(/I stopped because this was taking too long/i);
    expect(html).not.toMatch(/Sources gathered before the limit/i);
    expect(html).toContain("Show evidence");
    expect(html).not.toContain('data-testid="ask-evidence-open"');
  });

  it("legacy source-dump payloads still render four sections instead of a source wall", () => {
    const html = renderToStaticMarkup(
      createElement(AnswerModeOutputView, {
        output: SAMPLE,
        request: "Instagram Reels growth",
        fallback: createElement("div", { "data-testid": "legacy-fallback" }, "FINDINGS source cards"),
      }),
    );
    expect(html).toContain("Strategy");
    expect(html).toContain("Scripts");
    expect(html).toContain("Posting plan");
    expect(html).toContain("Monetization");
    expect(html).not.toContain("legacy-fallback");
    expect(html).not.toContain("Sources (");
  });
});
