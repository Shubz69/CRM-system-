import { describe, expect, it } from "vitest";
import { parseAiAnalysis } from "@/schemas/ai";
import { calculateLeadScore } from "@/services/scoring";

describe("AI JSON validation", () => {
  it("accepts a valid analysis payload", () => {
    const result = parseAiAnalysis({
      intent: "pricing_question",
      sentiment: "positive",
      conversation_summary: "Lead asked about pricing for coaching DMs.",
      qualification_score: 78,
      qualification_status: "qualified",
      qualification_reasons: ["Clear business use case"],
      answers_collected: { business_type: "Online coaching" },
      missing_qualification_fields: ["budget"],
      questions_detected: ["How much does it cost?"],
      objections_detected: [{ category: "price", text: "Worried it is expensive" }],
      buying_signals: ["Asked about onboarding"],
      recommended_next_action: "ask_qualification_question",
      should_handover: false,
      handover_reason: null,
      confidence: 0.91,
      reply: "Happy to help with pricing.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid analysis payloads", () => {
    const result = parseAiAnalysis({ intent: "x" });
    expect(result.success).toBe(false);
  });
});

describe("Lead scoring", () => {
  it("calculates a deterministic score with explanation components", () => {
    const analysis = parseAiAnalysis({
      intent: "booking_intent",
      sentiment: "positive",
      conversation_summary: "Founder runs a coaching business and wants to book a call.",
      qualification_score: 80,
      qualification_status: "qualified",
      qualification_reasons: ["Business fit"],
      answers_collected: { business_type: "Coaching", budget: "1000" },
      missing_qualification_fields: [],
      questions_detected: ["Can we start this month?"],
      objections_detected: [],
      buying_signals: ["Asked about onboarding", "Wants to book"],
      recommended_next_action: "send_booking_link",
      should_handover: false,
      handover_reason: null,
      confidence: 0.9,
      reply: "Here is a booking link.",
    });
    expect(analysis.success).toBe(true);
    if (!analysis.success) return;

    const score = calculateLeadScore({
      analysis: analysis.data,
      messageCount: 4,
    });

    expect(score.totalScore).toBeGreaterThan(50);
    expect(score.components.length).toBeGreaterThan(3);
    expect(score.explanation).toContain("businessFit");
  });

  it("applies disqualification penalty", () => {
    const analysis = parseAiAnalysis({
      intent: "opt_out",
      sentiment: "negative",
      conversation_summary: "Lead asked to stop messages.",
      qualification_score: 5,
      qualification_status: "disqualified",
      qualification_reasons: ["Opted out"],
      answers_collected: {},
      missing_qualification_fields: [],
      questions_detected: [],
      objections_detected: [],
      buying_signals: [],
      recommended_next_action: "disqualify",
      should_handover: false,
      handover_reason: null,
      confidence: 0.95,
      reply: "Understood.",
    });
    expect(analysis.success).toBe(true);
    if (!analysis.success) return;

    const score = calculateLeadScore({ analysis: analysis.data });
    expect(score.totalScore).toBeLessThan(40);
  });
});
