# Integrations setup

## ManyChat

1. Create a ManyChat automation that posts inbound DM events to:

```text
POST {APP_URL}/api/webhooks/manychat
Header: x-manychat-secret: {MANYCHAT_WEBHOOK_SECRET}
```

2. Suggested payload fields (flexible/passthrough):

```json
{
  "organisationId": "optional-cuid",
  "id": "event-id",
  "subscriber_id": "123",
  "ig_username": "lead_handle",
  "first_name": "Alex",
  "text": "Hello",
  "thread_id": "optional",
  "campaign": "spring-ads"
}
```

3. For local development, use **Simulator** instead of live ManyChat.
4. Outbound sending uses the adapter in `src/adapters/messaging`. If `MANYCHAT_API_TOKEN` is missing, the mock transport records the send.

## AI providers

| Provider | Env |
|----------|-----|
| Mock | `AI_PROVIDER=mock` |
| OpenAI | `AI_PROVIDER=openai`, `OPENAI_API_KEY` |
| Anthropic | `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` |

Configure model/tone/threshold in **AI Agent**.

## Booking

1. Set `DEFAULT_BOOKING_URL` or agent `bookingUrl`.
2. When qualified, the AI can append the booking link.
3. Booking provider webhook:

```text
POST {APP_URL}/api/webhooks/booking
Header: x-booking-secret: {BOOKING_WEBHOOK_SECRET}
```

```json
{
  "event": "created",
  "externalId": "evt_123",
  "contactEmail": "lead@example.com",
  "scheduledAt": "2026-08-06T15:00:00.000Z"
}
```

Events: `created`, `rescheduled`, `cancelled`, `attended`, `no_show`.

## Google Sheets / Email

Report generation stores a JSON payload and supports CSV export now.
Google Sheets and email delivery are adapter placeholders in the Reports UI — wire credentials later without changing report generation logic.

## Redis

Production: run Redis and `npm run worker`.
Local without Redis: worker falls back to an in-process interval loop.
