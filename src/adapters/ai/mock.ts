import type { AiCompletionRequest, AiProvider } from "@/adapters/ai/types";

/**
 * Deterministic development provider — no external API keys required.
 * Produces structured analysis suitable for local end-to-end testing.
 */
export class MockAiProvider implements AiProvider {
  readonly name = "mock";

  async complete(request: AiCompletionRequest): Promise<string> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content ?? "";
    return this.buildAnalysisJson(text);
  }

  async analyseConversation(input: {
    model?: string;
    systemPrompt: string;
    conversationTranscript: string;
    knowledgeContext: string;
    leadMessage: string;
  }): Promise<unknown> {
    const raw = this.buildAnalysisJson(input.leadMessage, input.knowledgeContext);
    return JSON.parse(raw) as unknown;
  }

  private buildAnalysisJson(leadMessage: string, knowledge = ""): string {
    const lower = leadMessage.toLowerCase();
    const asksPrice = /price|cost|how much|pricing|expensive/.test(lower);
    const asksHuman = /human|person|agent|talk to someone|real person/.test(lower);
    const optOut = /stop|unsubscribe|opt out|don't message/.test(lower);
    const buying = /book|schedule|call|demo|onboarding|sign up|start/.test(lower);
    const business = /business|coach|agency|brand|company|store/.test(lower);

    let qualification_score = 45;
    if (business) qualification_score += 20;
    if (buying) qualification_score += 15;
    if (asksPrice) qualification_score += 10;
    if (optOut) qualification_score = 5;

    const qualification_status =
      qualification_score >= 70
        ? "qualified"
        : qualification_score < 25
          ? "disqualified"
          : "qualifying";

    const objections_detected = asksPrice
      ? [{ category: "price", text: "Lead expressed price concern" }]
      : [];

    const questions_detected = asksPrice
      ? ["How much does it cost?"]
      : /\?/.test(leadMessage)
        ? [leadMessage.trim()]
        : [];

    const buying_signals = buying ? ["Expressed interest in booking or starting"] : [];

    let recommended_next_action:
      | "ask_qualification_question"
      | "answer_question"
      | "handle_objection"
      | "send_booking_link"
      | "handover_to_human"
      | "disqualify" = "ask_qualification_question";

    if (asksHuman) recommended_next_action = "handover_to_human";
    else if (optOut) recommended_next_action = "disqualify";
    else if (qualification_status === "qualified" && buying) {
      recommended_next_action = "send_booking_link";
    } else if (asksPrice) recommended_next_action = "handle_objection";
    else if (questions_detected.length) recommended_next_action = "answer_question";

    const hasPricingGuidance = /pricing|price|£|\$|cost/i.test(knowledge);
    let reply =
      "Thanks for reaching out! To see if we are a fit, could you share what kind of business you run and roughly how many Instagram DMs you get each month?";

    if (asksHuman) {
      reply =
        "Absolutely — I will connect you with a teammate who can help. Someone will pick this up shortly.";
    } else if (optOut) {
      reply = "Understood. I will stop messaging you. Take care!";
    } else if (asksPrice) {
      reply = hasPricingGuidance
        ? "Great question on pricing. Based on our current packages, pricing depends on volume and setup needs — I can share guidance and book a short call to map the best option for you."
        : "Pricing depends on your setup and volume. I do not want to guess — the best next step is a short call so we can tailor this properly. Would you like a booking link?";
    } else if (recommended_next_action === "send_booking_link") {
      reply =
        "You sound like a strong fit. Here is a link to book a quick intro call when you are free.";
    }

    return JSON.stringify({
      intent: asksPrice
        ? "pricing_question"
        : buying
          ? "booking_intent"
          : asksHuman
            ? "human_request"
            : "general_inquiry",
      sentiment: optOut ? "negative" : buying ? "positive" : "neutral",
      conversation_summary: `Lead said: ${leadMessage.slice(0, 180)}`,
      qualification_score,
      qualification_status,
      qualification_reasons: business
        ? ["Mentions a business use case"]
        : ["Still gathering qualification details"],
      answers_collected: business
        ? { business_type: "Mentioned in conversation" }
        : {},
      missing_qualification_fields: business ? ["budget", "monthly_dm_volume"] : ["business_type", "budget"],
      questions_detected,
      objections_detected,
      buying_signals,
      recommended_next_action,
      should_handover: asksHuman,
      handover_reason: asksHuman ? "Lead requested a human" : null,
      confidence: 0.86,
      reply,
    });
  }
}
