/**
 * Every Ask-page card must route to the right agent in QUICK mode (the page always
 * POSTs answerMode QUICK) and never stall on a clarification.
 */
import { describe, expect, it } from "vitest";
import { ASK_OUTCOME_CARDS } from "@/lib/navigation";
import {
  extractImageBrief,
  hasImageBrief,
  looksLikeContentWriting,
  looksLikeCrmInternal,
  looksLikeDmTriageAsk,
  looksLikeObjectionsAsk,
  looksLikeResearch,
  looksLikeResultsReportAsk,
  planAgentRunDeterministic,
} from "@/agents/supervisor/plan";

const QUICK = { organisationId: "org_cards", answerMode: "QUICK" as const };

function firstStep(prompt: string, org: Parameters<typeof planAgentRunDeterministic>[1] = QUICK) {
  const plan = planAgentRunDeterministic(prompt, org);
  expect(plan.kind, `"${prompt}" should plan, not clarify`).toBe("plan");
  if (plan.kind !== "plan") throw new Error("unreachable");
  expect(plan.plan.steps).toHaveLength(1);
  return plan.plan.steps[0]!;
}

function crmIntent(prompt: string, org?: Parameters<typeof planAgentRunDeterministic>[1]) {
  const step = firstStep(prompt, org);
  expect(step.agentName).toBe("crm_desk");
  return (step.input as { intent?: string }).intent;
}

describe("Ask cards — QUICK routing (card titles and card prefills)", () => {
  it("What needs my attention? → crm_desk", () => {
    expect(firstStep("What needs my attention?").agentName).toBe("crm_desk");
  });

  it.each([
    "Summarise my pipeline",
    "Summarise my current sales pipeline and tell me which deals are stuck.",
  ])("pipeline: %s → crm_desk pipeline_summary", (q) => {
    expect(crmIntent(q)).toBe("pipeline_summary");
  });

  it.each(["Help me handle DMs", "Help me respond to open Instagram conversations"])(
    "DMs: %s → crm_desk dm_triage",
    (q) => {
      expect(crmIntent(q)).toBe("dm_triage");
    },
  );

  it.each(["Common objections this week", "What objections came up in recent conversations?"])(
    "objections: %s → crm_desk objections (not the operator brief)",
    (q) => {
      expect(crmIntent(q)).toBe("objections");
    },
  );

  it.each(["Show me results", "Weekly performance", "Give me a weekly performance briefing"])(
    "results: %s → crm_desk results_report",
    (q) => {
      expect(crmIntent(q)).toBe("results_report");
    },
  );

  it.each(["Research bridal hair trends in Leeds with sources", "Research bridal hair trends in Leeds"])(
    "research: %s → research (FAST)",
    (q) => {
      const step = firstStep(q);
      expect(step.agentName).toBe("research");
      expect((step.input as { depth?: string }).depth).toBe("FAST");
    },
  );

  it.each(["What's trending in hair colour content right now?", "Social listening on hair colour trends"])(
    "trending: %s → social_listening",
    (q) => {
      const plan = planAgentRunDeterministic(q, QUICK);
      expect(plan.kind).toBe("plan");
      if (plan.kind !== "plan") return;
      expect(plan.plan.steps[0]?.agentName).toBe("social_listening");
    },
  );

  it.each([
    "Write an Instagram post about our bridal hair packages",
    "Write content about our bridal hair packages",
  ])("content: %s → content_writer (no research dependency)", (q) => {
    const step = firstStep(q);
    expect(step.agentName).toBe("content_writer");
    expect((step.input as { request?: string }).request).toBe(q);
    expect(looksLikeResearch(q)).toBe(false);
  });

  it.each([
    "Make an image for a bridal hair promo",
    "Make something like this reference: bridal hair promo",
  ])("image with a brief: %s → imaging_generate without an upload", (q) => {
    const step = firstStep(q);
    expect(step.agentName).toBe("imaging_generate");
    const input = step.input as { prompt?: string; referenceAssetId?: string; request?: string };
    expect(input.prompt).toMatch(/bridal hair promo/i);
    expect(input.referenceAssetId).toBeUndefined();
    expect(input.request).toBe(q);
  });

  it("a reference upload still goes through imaging_analyze", () => {
    const step = firstStep("Make something like this reference: bridal hair promo", {
      ...QUICK,
      referenceAssetId: "asset_1",
    });
    expect(step.agentName).toBe("imaging_analyze");
  });

  it("every card on the Ask page plans in QUICK (no clarification loop)", () => {
    const titles = ASK_OUTCOME_CARDS.map((c) => c.title);
    const prefills = ASK_OUTCOME_CARDS.filter((c) => c.prefill).map((c) =>
      // Topic cards ("Research ", "Write content about ") need a topic typed in.
      /\s$|:\s*$/.test(c.prefill!) ? `${c.prefill!.trimEnd()} bridal hair packages` : c.prefill!,
    );
    for (const prompt of [...titles, ...prefills]) {
      if (/^(research a topic|what's trending|write content|make an image)$/i.test(prompt)) continue;
      const plan = planAgentRunDeterministic(prompt, QUICK);
      expect(plan.kind, `"${prompt}"`).toBe("plan");
    }
  });
});

describe("Ask cards — CRM intents survive ACTION/EXECUTIVE", () => {
  it.each([
    ["Common objections this week", "objections"],
    ["Help me handle DMs", "dm_triage"],
    ["Weekly performance", "results_report"],
  ])("%s keeps %s instead of the generic operator brief", (q, intent) => {
    expect(crmIntent(q, { organisationId: "org_cards", answerMode: "ACTION" })).toBe(intent);
    expect(crmIntent(q, { organisationId: "org_cards", answerMode: "EXECUTIVE" })).toBe(intent);
  });
});

describe("Ask cards — detectors do not hijack other asks", () => {
  it("CRM card asks take the in-process CRM fast path", () => {
    for (const q of [
      "Help me handle DMs",
      "Common objections this week",
      "Show me results",
      "Weekly performance",
      "Give me a weekly performance briefing",
    ]) {
      expect(looksLikeCrmInternal(q), q).toBe(true);
    }
  });

  it("pasted text about DMs is still summarised, not triaged", () => {
    const q = "Summarise this: We help local clinics book more consults through Instagram DMs every week.";
    expect(looksLikeDmTriageAsk(q)).toBe(false);
    const step = firstStep(q, { organisationId: "org_cards" });
    expect(step.agentName).toBe("summarise");
  });

  it("objection research with web sources stays research", () => {
    expect(looksLikeObjectionsAsk("Research common objections to salon pricing")).toBe(true);
    expect(firstStep("Research common objections to salon pricing").agentName).toBe("research");
  });

  it("content ideation stays on the operator brief; approval queue stays on content_awaiting_approval", () => {
    expect(looksLikeContentWriting("What content should I create this week?")).toBe(false);
    expect(crmIntent("What content should I create this week?")).toBe("operator_brief");
    expect(looksLikeContentWriting("What content is awaiting approval?")).toBe(false);
    expect(crmIntent("What content is awaiting approval?")).toBe("content_awaiting_approval");
  });

  it("image creation phrasing is imaging, not copywriting", () => {
    expect(looksLikeContentWriting("Create an Instagram graphic for our spring offer")).toBe(false);
    expect(firstStep("Create an Instagram graphic for our spring offer").agentName).toBe("imaging_generate");
  });

  it("results detector ignores research results", () => {
    expect(looksLikeResultsReportAsk("Show me results")).toBe(true);
    expect(firstStep("Research results on balayage aftercare").agentName).toBe("research");
  });
});

describe("image brief extraction", () => {
  it.each([
    ["Make an image for a bridal hair promo", "a bridal hair promo", true],
    ["Make me an image of a calm wellness studio", "a calm wellness studio", true],
    ["Make something like this reference: bridal hair promo", "bridal hair promo", true],
    ["Create an Instagram graphic for our spring offer", "our spring offer", true],
    ["Make something like this reference: ", "", false],
    ["Make me something like this", "", false],
    ["Generate an image", "", false],
  ])("%s → %s", (q, brief, ok) => {
    expect(extractImageBrief(q)).toBe(brief);
    expect(hasImageBrief(extractImageBrief(q))).toBe(ok);
  });

  it("a referenced photo without enough brief still needs the upload", () => {
    const plan = planAgentRunDeterministic("based on this photo, make it warmer", QUICK);
    expect(plan.kind).toBe("clarification");
  });
});
