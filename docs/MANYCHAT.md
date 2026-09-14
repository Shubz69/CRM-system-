# ManyChat integration

Agent Desk uses ManyChat as the Instagram DM transport.

## Workspace setup (Integrations)

Every workspace is isolated. **Do not reuse another organisation’s webhook secret or `organisationId`.** Credentials from one tenant will not authorize inbound events for another.

Open **Integrations**. **Social Accounts** (Instagram / LinkedIn / YouTube) stays at the top.

Scroll to **Messaging setup**, or open `/integrations?setup=messaging` (also linked from Inbox empty state). That section is required to configure **this organisation’s** webhook secret. Until an org secret exists, inbound `WEBHOOK_RECEIVE` stays AUTH_REQUIRED for that workspace (the environment secret is a fallback for local/dev channel mapping only — it cannot authorize a payload `organisationId` alone).

From Messaging setup:

1. Copy **this workspace’s** webhook URL and **organisationId**. Include that `organisationId` on every inbound payload for this tenant.
2. Click **Regenerate secret**, copy the value once, and set header `x-manychat-secret` on **this workspace’s** ManyChat External Request. Each organisation has its own secret; regenerating in one workspace does not change another.
3. Optionally paste or rotate the **API token** for outbound replies. The plaintext is never returned after save.
4. Click **Test inbound** to process a sample message inside **this** CRM workspace (nothing is sent to Instagram).
5. **Disconnect** / **Reconnect** and **Validate configuration** remain available when a stored token exists.

Workspace owners and administrators (`integrations:manage`) can load and mutate this API for their active organisation only. Read-only members cannot. Passing another workspace’s `organisationId` in the request body is rejected.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/webhooks/manychat` | Primary inbound webhook |
| POST | `/api/integrations/manychat/inbound` | Alias of the primary webhook |
| GET/POST | `/api/integrations/manychat` | Status, regenerate secret, test inbound/outbound (session org only) |

## Authentication

Send header:

```http
x-manychat-secret: <this-workspace-secret>
```

(`x-webhook-secret` is also accepted.)

Secrets are checked against:

1. Per-organisation encrypted secret (regenerated from **Integrations → Messaging setup**) — required for production inbound when identifying the tenant by `organisationId`
2. `MANYCHAT_WEBHOOK_SECRET` environment variable — may only authorize writes when `channel_id` uniquely maps to one organisation; it cannot authorize an arbitrary payload `organisationId`

Never return the full saved token after storage — the UI shows a masked value. Regeneration returns the new secret once, for the signed-in workspace only.

## Required payload

```json
{
  "organisationId": "<this-workspace-org-cuid>",
  "subscriber_id": "123456",
  "text": "Hi, how much does this cost?",
  "id": "unique-event-id"
}
```

Use the `organisationId` shown on **that** workspace’s Integrations page. Useful optional fields: `ig_username`, `first_name`, `last_name`, `email`, `phone`, `thread_id`, `campaign`, `channel_id`.

## ManyChat automation steps

1. Create a Flow triggered on Instagram DM **in this ManyChat account**.
2. Add an **External Request** (or Dynamic Block) that POSTs to your webhook URL.
3. Set `x-manychat-secret` to **this workspace’s** regenerated secret (not another tenant’s).
4. Map ManyChat subscriber fields into the JSON body and set `organisationId` to **this workspace’s** id.
5. Optionally handle the JSON response for a synchronous Dynamic Block reply.
6. Repeat secret + `organisationId` mapping independently for every additional Agent Desk workspace.

## Local testing

1. Open **Integrations → Messaging setup** and click **Test inbound**.
2. Or use the **Simulator** (labelled test data).
3. Or `curl` the webhook with the **org** secret from Integrations (preferred) or the env secret plus a unique `channel_id`.

## Outbound

When `MANYCHAT_API_TOKEN` is unset, the mock adapter logs outbound sends without calling ManyChat. Set the token (env or this workspace’s Integrations API token field) to enable live sends. Tokens are stored per organisation.
