import { z } from "zod";

export const objectionSchema = z.object({
  category: z.string().min(1),
  text: z.string().min(1),
});

export const aiAnalysisSchema = z.object({
  intent: z.string().min(1),
  sentiment: z.enum(["positive", "neutral", "negative", "mixed"]),
  conversation_summary: z.string().min(1),
  qualification_score: z.number().min(0).max(100),
  qualification_status: z.enum([
    "unknown",
    "qualifying",
    "qualified",
    "disqualified",
  ]),
  qualification_reasons: z.array(z.string()).default([]),
  answers_collected: z.record(z.string()).default({}),
  missing_qualification_fields: z.array(z.string()).default([]),
  questions_detected: z.array(z.string()).default([]),
  objections_detected: z.array(objectionSchema).default([]),
  buying_signals: z.array(z.string()).default([]),
  recommended_next_action: z.enum([
    "ask_qualification_question",
    "answer_question",
    "handle_objection",
    "send_booking_link",
    "follow_up_later",
    "handover_to_human",
    "disqualify",
    "nurture",
  ]),
  should_handover: z.boolean(),
  handover_reason: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reply: z.string().min(1),
});

export type AiAnalysis = z.infer<typeof aiAnalysisSchema>;

export function parseAiAnalysis(input: unknown): {
  success: true;
  data: AiAnalysis;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = aiAnalysisSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: result.error };
}
