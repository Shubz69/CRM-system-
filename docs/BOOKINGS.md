# Bookings

Sending a booking link does **not** mark a lead as booked.

## Statuses

| Status | Meaning |
|--------|---------|
| `OFFERED` | Link sent by AI/automation |
| `CREATED` | Provider confirmed a booking |
| `RESCHEDULED` | Time changed |
| `CANCELLED` | Cancelled |
| `ATTENDED` | Call attended |
| `NO_SHOW` | No-show |

## Webhooks

| Path | Provider |
|------|----------|
| `/api/webhooks/booking` | Generic / link |
| `/api/integrations/booking/calendly/webhook` | Calendly-shaped payloads |
| `/api/integrations/booking/calcom/webhook` | Cal.com-shaped payloads |

Authenticate with header `x-booking-secret` matching `BOOKING_WEBHOOK_SECRET`.

Always include `organisationId`. Contact matching uses `contactEmail` or ManyChat `contactExternalId`.

## Settings

Set your agent booking URL and/or optional `DEFAULT_BOOKING_URL`. Provider: `BOOKING_PROVIDER=link|mock`.
