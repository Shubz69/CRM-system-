import { describe, expect, it } from "vitest";
import { ASK_SHOW_SOURCES_BY_DEFAULT, ASK_TYPED_ANSWER_LABELS } from "@/lib/ask-result-ui";
import {
  buildTypedAnswers,
  buildVideoExamples,
  hasCompleteTypedAnswers,
  looksLikeContentOrGrowthAsk,
  resolveTypedAnswers,
  stripUrlsForAskDisplay,
} from "@/services/answer-modes/typed-answers";
import { getVideoProvider, isVideoProviderConfigured, VideoProviderNotConfiguredError } from "@/adapters/video";
import { shapeFinalOutputForMode } from "@/services/answer-modes/shape";

const IG_RAW = {
  researchJobId: "rj_ig",
  topic: "Instagram Reels growth for a personal brand",
  summary: "Short-form Reels with a clear hook and weekly cadence outperform random posting.",
  claims: [
    {
      claim: "Accounts posting 4–6 Reels a week grow faster than sporadic posters.",
      sourceUrl: "https://example.com/reels-playbook",
    },
  ],
  findings: [
    {
      claim: "Accounts posting 4–6 Reels a week grow faster than sporadic posters.",
      sourceUrl: "https://example.com/reels-playbook",
      evidenceExcerpt: "weekly reel cadence",
    },
  ],
  sources: [
    {
      url: "https://example.com/reels-playbook",
      title: "Reels playbook",
      snippet: "weekly reel cadence",
      platform: "web",
    },
  ],
  contentHooks: ["Hook: I wasted a year posting daily carousels."],
};

describe("Ask typed answers schema helpers", () => {
  it("always returns the four labeled sections and never puts URLs in bodies", () => {
    const answers = buildTypedAnswers(IG_RAW, "What Instagram Reels strategy should I use to grow?");
    expect(answers.strategy.title).toBe(ASK_TYPED_ANSWER_LABELS.strategy);
    expect(answers.scripts.title).toBe(ASK_TYPED_ANSWER_LABELS.scripts);
    expect(answers.postingPlan.title).toBe(ASK_TYPED_ANSWER_LABELS.posting_plan);
    expect(answers.monetization.title).toBe(ASK_TYPED_ANSWER_LABELS.monetization);
    for (const section of [answers.strategy, answers.scripts, answers.postingPlan, answers.monetization]) {
      expect(section.body.trim().length).toBeGreaterThan(8);
      expect(section.body).not.toMatch(/https?:\/\//i);
    }
    expect(hasCompleteTypedAnswers({ ...IG_RAW, typedAnswers: answers })).toBe(true);
  });

  it("never returns blank sections even when research is empty", () => {
    const answers = resolveTypedAnswers(
      { summary: "I ran out of time before sourced findings were ready." },
      "Research plant hire UK pricing",
    );
    expect(answers.strategy.body.length).toBeGreaterThan(8);
    expect(answers.scripts.body.length).toBeGreaterThan(8);
    expect(answers.postingPlan.body.length).toBeGreaterThan(8);
    expect(answers.monetization.body.length).toBeGreaterThan(8);
  });

  it("strips source URLs from customer-facing copy", () => {
    expect(stripUrlsForAskDisplay("See https://example.com/a for rates")).not.toMatch(/https?:\/\//);
  });

  it("detects growth/content Asks for video briefs", () => {
    expect(
      looksLikeContentOrGrowthAsk(
        "What Instagram Reels content and posting strategy should @shubzfx use to grow",
      ),
    ).toBe(true);
    expect(looksLikeContentOrGrowthAsk("What's stalled in my pipeline?")).toBe(false);
  });
});

describe("Ask example video briefs", () => {
  it("returns Instagram + LinkedIn briefs and fail-closed AUTH_REQUIRED when no provider is wired", () => {
    expect(isVideoProviderConfigured()).toBe(false);
    expect(() => getVideoProvider()).toThrow(VideoProviderNotConfiguredError);
    try {
      getVideoProvider();
    } catch (error) {
      expect(error).toBeInstanceOf(VideoProviderNotConfiguredError);
      expect((error as VideoProviderNotConfiguredError).code).toBe("AUTH_REQUIRED");
      expect((error as VideoProviderNotConfiguredError).reason).toBe("VIDEO_PROVIDER_NOT_CONFIGURED");
    }

    const videos = buildVideoExamples({
      raw: IG_RAW,
      request: "Instagram Reels growth strategy",
      videoConfigured: false,
    });
    expect(videos.length).toBeGreaterThanOrEqual(2);
    expect(videos[0]?.platform).toBe("instagram");
    expect(videos[1]?.platform).toBe("linkedin");
    for (const video of videos) {
      expect(video.title.length).toBeGreaterThan(4);
      expect(video.hook.length).toBeGreaterThan(4);
      expect(video.shotList.length).toBeGreaterThan(1);
      expect(video.lengthSeconds).toBeGreaterThan(0);
      expect(video.status).toBe("not_configured");
      expect(video.code).toBe("AUTH_REQUIRED");
      expect(video.url).toBeUndefined();
    }
  });
});

describe("shaped Ask output carries four sections for every workspace", () => {
  it("attaches typedAnswers on QUICK shape without requiring a specific tenant", () => {
    const shaped = shapeFinalOutputForMode("QUICK", IG_RAW, "Grow on Instagram with Reels");
    expect(shaped?.mode).toBe("quick");
    expect(shaped?.typedAnswers?.strategy.title).toBe("Strategy");
    expect(shaped?.typedAnswers?.scripts.title).toBe("Scripts");
    expect(shaped?.typedAnswers?.postingPlan.title).toBe("Posting plan");
    expect(shaped?.typedAnswers?.monetization.title).toBe("Monetization");
    expect(shaped?.videoExamples?.length).toBeGreaterThan(0);
    expect(ASK_SHOW_SOURCES_BY_DEFAULT).toBe(false);
  });
});
