# ManyChat integration

Agent Desk uses ManyChat as the Instagram DM transport.

## Workspace setup (Integrations)

Open **Integrations**. **Social Accounts** (Instagram / LinkedIn / YouTube) stays at the top.

Scroll to **Messaging setup**, or open `/integrations?setup=messaging` (also linked from Inbox empty state). That section is required to configure the organisation webhook secret. Until an org secret exists, inbound `WEBHOOK_RECEIVE` stays AUTH_REQUIRED (the environment secret is a fallback for local/dev only).

From Messaging setup:

1. Copy the **webhook URL** and **organisationId**. Include `organisationId` on every inbound payload.
2. Click **Regenerate secret**, copy the value once, and set header `x-manychat-secret` on the ManyChat External Request. The UI then shows only a masked status.
3. Optionally paste or rotate the **API token** for outbound replies. The plaintext is never returned after save.
4. Click **Test inbound** to process a sample message inside the CRM (nothing is sent to Instagram).
5. **Disconnect** / **Reconnect** and **Validate configuration** remain available when a stored token exists.

Workspace owners and administrators (`integrations:manage`) can load and mutate this API. Read-only members cannot.

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
2. Optional per-organisation encrypted secret (regenerated from **Integrations → Messaging setup**)

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
4. Map ManyChat subscriber fields into the JSON body (include `organisationId`).
5. Optionally handle the JSON response for a synchronous Dynamic Block reply.

## Local testing

1. Open **Integrations → Messaging setup** and click **Test inbound**.
2. Or use the **Simulator** (labelled test data).
3. Or `curl` the webhook with the secret from `.env`.

## Outbound

When `MANYCHAT_API_TOKEN` is unset, the mock adapter logs outbound sends without calling ManyChat. Set the token (env or Integrations API token field) to enable live sends.
