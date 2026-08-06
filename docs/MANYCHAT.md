# ManyChat integration

DM Intelligence uses ManyChat as the Instagram DM transport.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/webhooks/manychat` | Primary inbound webhook |
| POST | `/api/integrations/manychat/inbound` | Alias of the primary webhook |
| GET/POST | `/api/integrations/manychat` | Status, regenerate secret, test inbound/outbound |

## Authentication

Send header:

```http
x-manychat-secret: <secret>
```

(`x-webhook-secret` is also accepted.)

Secrets are checked against:

1. `MANYCHAT_WEBHOOK_SECRET` environment variable
2. Optional per-organisation encrypted secret (regenerated from **Integrations**)

Never return the full saved token after storage — the UI shows a masked value. Regeneration returns the new secret once.

## Required payload

```json
{
  "organisationId": "<org-cuid>",
  "subscriber_id": "123456",
  "text": "Hi, how much does this cost?",
  "id": "unique-event-id"
}
```

Useful optional fields: `ig_username`, `first_name`, `last_name`, `email`, `phone`, `thread_id`, `campaign`, `channel_id`.

## ManyChat automation steps

1. Create a Flow triggered on Instagram DM.
2. Add an **External Request** (or Dynamic Block) that POSTs to your webhook URL.
3. Set the `x-manychat-secret` header.
4. Map ManyChat subscriber fields into the JSON body.
5. Optionally handle the JSON response for a synchronous Dynamic Block reply.

## Local testing

1. Open **Integrations** and click **Test inbound webhook**.
2. Or use the **Simulator** (labelled test data).
3. Or `curl` the webhook with the secret from `.env`.

## Outbound

When `MANYCHAT_API_TOKEN` is unset, the mock adapter logs outbound sends without calling ManyChat. Set the token to enable live sends.
