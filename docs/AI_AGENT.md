# AI Agent

## Providers

Configured via `AI_PROVIDER`:

- `mock` (default for local)
- `openai` (`OPENAI_API_KEY`)
- `anthropic` (`ANTHROPIC_API_KEY`)

All providers share one analysis interface. Business logic never calls a vendor SDK directly.

## Structured output

Every AI reply is validated with Zod (`src/schemas/ai.ts`). On failure the system retries once with a repair instruction. A second failure pauses AI, creates a human-review task, and may create a knowledge recommendation.

## Guardrails

The agent must not invent pricing, guarantees, availability, or discounts outside knowledge. Booking links are only appended when the recommended action is `send_booking_link` and the messaging window is open.

## Configuration UI

`/agent` — brand voice, qualification questions, scoring rules, booking URL, follow-up delays, confidence threshold.

## Testing

Use `/simulator` for end-to-end journeys without Instagram. Provider keys are never exposed in the UI or logs.
