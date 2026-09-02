# Social Prospecting + Outreach Runbook

## Version 1 (LIVE-CAPABLE discovery)

Works **without** restricted LinkedIn communication APIs and **without** Ayrshare.

1. Growth → **Prospecting** (`/growth/prospecting`)
2. Enter natural language ICP (“Find 5 UK recruitment company founders”)
3. Discovery invokes existing research adapters progressively (CRM/knowledge → Tavily/web → approved Apify social) under Compute Governor + hard cost caps — **not** LinkedIn Marketing API member data
4. `SocialIdentityResolver` attaches profile URLs only when evidence supports VERIFIED/LIKELY; otherwise UI shows **Profile not verified**
5. Quality gate dedupes, caps confidence, requires evidence
6. Universal actions by network:
   - LinkedIn: Open LinkedIn · Copy Connection Note · Copy Follow-up DM
   - Instagram: Open Instagram · Copy DM
   - Other networks: Open Profile · Copy Outreach
7. Add to CRM · Create Opportunity
8. User marks: Connection Sent · Connected · Follow-up Sent
9. System **never** claims it sent a LinkedIn connection/message for manual actions (`providerSent=false`)

Seed/`seedCandidates` remain for **tests and demo fixtures only**. Interactive UI always runs live research.

### Cost safety (defaults)

| Cap | Default |
|-----|---------|
| maxCandidates | 10 (also min(desiredCount)) |
| maxSources | 8 |
| maxExternalCalls | 6 |
| maxEstimatedCostCents | 50 |
| maxResearchDepth | STANDARD |

If Tavily/Apify are missing, discovery **degrades honestly** (notes in API `progress.degradationNotes`) and does not crash.

## Bounded LIVE validation (manual — max 3 queries)

Do **not** auto-contact anyone. Keep cost caps tight.

### Query 1
`Find 5 UK recruitment company founders`

### Query 2
`Find 5 London dental practice owners`

### Query 3
`Find 5 Manchester fitness creators on Instagram`

For **each candidate**, manually verify:

- [ ] Person is real
- [ ] Company is real
- [ ] Profile URL opens (if shown)
- [ ] Profile belongs to the correct candidate (not a namesake)
- [ ] “Why selected” is evidence-backed
- [ ] Outreach references real facts only (no fabricated “saw your post”)
- [ ] Unverified profiles show **Profile not verified** instead of a guessed URL

Stop after these three queries during initial validation.

## Version 2 LinkedIn (IMPLEMENTED, HARD-DISABLED)

Native adapter stubs exist:

- `sendConnectionInvitation`
- `getInvitationStatus`
- `listAuthenticatedUserConnections`
- `sendLinkedInMessage`
- `replyToLinkedInConversation`
- `getLinkedInConversation`

All default to `REQUIRES_PROVIDER_APPROVAL`.

Server flags (not user toggles):

```
LINKEDIN_INVITATIONS_API_APPROVED
LINKEDIN_CONNECTIONS_API_APPROVED
LINKEDIN_MESSAGES_API_APPROVED
ALLOW_LINKEDIN_RESTRICTED_APIS
```

Both a capability flag **and** `ALLOW_LINKEDIN_RESTRICTED_APIS=1` are required.  
Even then, live LinkedIn wiring is not production-enabled until explicitly completed after LinkedIn approval.

**Never** use Selenium/Playwright/browser automation against linkedin.com for outreach.

## Ayrshare (OPTIONAL)

- Primary API key: `AYRSHARE_API_KEY` — **server only**
- Tenant mapping: `AyrshareProfile` (one org → one profile)
- UI: Integrations → Connect social accounts (JWT/social-link flow)
- Webhook: `POST /api/webhooks/ayrshare` with `AYRSHARE_WEBHOOK_SECRET`
- Publishing can use `publishViaAyrshare` (Content OS remains authoritative for approvals)
- **Removing Ayrshare must not remove prospecting** — discovery/identity/outreach/CRM are provider-independent

## Instagram

- Prefer Ayrshare for publish/schedule/analytics/history/comments where supported
- Keep existing `META_INSTAGRAM` + `MANYCHAT` for Inbox DMs
- All Inbox traffic still normalizes via Contact / Conversation / Message
- Outbound Inbox sends still use `dispatchOutboundMessage()`
- Cold DM without provider permission → Open Instagram + Copy Message
- **Send Message** only when an existing permitted conversation exists

## LinkedIn compliance

Do **not** use LinkedIn Marketing API member data for:

- sales prospect identification
- lead creation
- CRM enrichment
- joining LinkedIn member data with external prospect datasets

A LinkedIn profile URL may be attached when independently discovered and verified.

## Provider architecture

```
Research Providers → Prospect Discovery → Identity Resolution → Quality → Outreach → CRM
Social Provider Router → Zernio (preferred when configured) | Ayrshare | Meta Direct | ManyChat | LinkedIn Native
```

New messaging providers implement `SocialMessagingProviderAdapter` (see `provider-router.ts`) — no prospecting schema redesign.

## Zernio validation provider

Zernio is the **default validation** social provider when `ZERNIO_API_KEY` is set. It remains optional — removing it must not break Find Prospects / Open / Copy / Add to CRM.

### Env (server only)

```
ZERNIO_API_KEY=
ZERNIO_WEBHOOK_SECRET=
```

Never expose the master key to the browser. Webhook: `POST /api/webhooks/zernio` verifies `X-Zernio-Signature` (HMAC-SHA256 hex of raw body).

### Tenant mapping

Agent Desk Organisation → one `ZernioProfile` (`organisationId` unique, stores `zernioProfileId`).

### Bounded LIVE account allowance (2 free accounts)

Use exactly:

1. **Account 1** — one Instagram Professional (Business/Creator) via Instagram Login (no Facebook Page required on this path)
2. **Account 2** — one LinkedIn account (personal and/or company page as Zernio allows)

### Zernio LIVE checklist

- [ ] Instagram OAuth connect from Integrations → Social Accounts → Instagram → Connect
- [ ] LinkedIn OAuth connect
- [ ] Account health / sync shows connected
- [ ] One Instagram publish (no mass posting)
- [ ] One LinkedIn publish
- [ ] IG analytics pull (or webhook analytics.synced)
- [ ] LI analytics pull
- [ ] One permitted IG **inbound** message → webhook `message.received` → Agent Desk inbox normalization path
- [ ] Confirm LinkedIn DMs remain Open + Copy (not sent via Zernio)
- [ ] Confirm cold IG DM remains Open + Copy
- [ ] Webhook receipt + idempotency (duplicate delivery ignored)
- [ ] READ_ONLY cannot connect (`integrations:manage` denied)

No cold DM automation. No mass posting.

## Provider limitations

| Provider | Discovery | Connection invite | DMs |
|----------|-----------|-------------------|-----|
| Research engine | Yes | N/A | N/A |
| Zernio | No | No | Instagram permitted only; LinkedIn DMs unsupported |
| Ayrshare | Not sole people-search | No | Where network permits |
| META_INSTAGRAM | No | No | Windowed / contactable |
| MANYCHAT | No | No | Yes (existing) |
| LINKEDIN_NATIVE | No (prohibited use) | V2 blocked | V2 blocked |

## Approval requirements

LinkedIn restricted APIs: official LinkedIn product approval + dual env flags + adapter wiring review.

## LIVE_E2E plan (operator)

1. Ensure `TAVILY_API_KEY` (and optionally `APIFY_TOKEN`) in staging — or accept degraded CRM/web-only results
2. Run the three bounded queries above
3. Add to CRM → verify Contact/Company/Opportunity provenance
4. Prepare outreach → copy note → open profile manually → mark Connection Sent
5. Confirm `providerSent=false` on thread
6. Confirm ManyChat/Meta still healthy with Zernio/Ayrshare unconfigured and vice versa
7. Confirm READ_ONLY cannot prospect-write (`leads:write` denied)
8. Run Zernio LIVE checklist (two accounts only)

## Migration

1. `prisma/migrations/20260902120000_social_prospecting_outreach` — social prospecting models + `socialIdentities`
2. `prisma/migrations/20260902140000_zernio_provider` — `ZernioProfile` + `IntegrationType.ZERNIO`

**Choice:** Zernio uses a **separate** additive migration because the social-prospecting migration is already in checkpoint commit `3fa9bbe` and must not be rewritten.

Apply only with `npx prisma migrate deploy` when ready. **Do not** `db push`.  
This implementation pass does **not** apply production migrations.
