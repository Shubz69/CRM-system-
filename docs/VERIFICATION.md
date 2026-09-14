# Verification — Ask research, Zernio vs native OAuth

Do **not** invent OAuth credentials. Native Connect stays off until the env vars below are set in the host environment (Vercel / Railway / `.env`).

## Native OAuth env vars (optional, separate from Zernio)

Workspace Instagram / LinkedIn / YouTube Connect on Integrations uses **Zernio**. These vars only enable the **native** Graph / LinkedIn / TikTok OAuth path.

```
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
INSTAGRAM_REDIRECT_URI=https://<app>/api/social/instagram/callback

LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_REDIRECT_URI=https://<app>/api/social/linkedin/callback

TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_REDIRECT_URI=https://<app>/api/social/tiktok/callback
```

TikTok Connect is **not** shown until all three `TIKTOK_*` vars are set. Admin health “TikTok native OAuth · Not Configured” is expected when they are missing. That does **not** mean Zernio Instagram/LinkedIn is disconnected.

Also used (already operational in production when present):

- `ZERNIO_API_KEY` / `ZERNIO_WEBHOOK_SECRET` — workspace Social Accounts
- `APIFY_TOKEN` — public listen (IG / LinkedIn / TikTok / X / Threads)
- `MANYCHAT_API_TOKEN` — outbound send; org webhook secret is separate (`WEBHOOK_RECEIVE`)

## Admin / Integrations honesty

1. Integrations Social Accounts: Instagram/LinkedIn **Connected via Zernio** while Admin **Instagram/LinkedIn native OAuth** can be Not Configured.
2. Admin has a **Zernio (workspace social)** row distinct from native OAuth rows.
3. No TikTok Connect button unless native TikTok env is configured.
4. ManyChat “Live adapter selected” is send-path only. Zernio webhook IGNORED/FAILED is a different path. `WEBHOOK_RECEIVE` stays AUTH_REQUIRED without the org webhook secret.
5. MessagingChannel must not keep a fake `demo_account` handle when a real username arrives on inbound.

## Ask research

```bash
npx tsc --noEmit
npx vitest run tests/ask-research-degradation.test.ts tests/research-latency-budget.test.ts tests/research-evidence-visibility.test.ts tests/research-listen-platforms.test.ts tests/rqs-handoff.test.ts tests/connector-capability-honesty.test.ts
```

1. Quick Ask `Research plant hire UK pricing` — finishes in a few seconds; findings + source URLs; web-only (no Apify fan-out). Hard cap ~30s on Deep.
2. Ask `Instagram growth content strategy` — sources/findings labeled **Apify · Instagram** with URL + snippet. Never “No findings yet” when sources were fetched. No invented stats.
3. `GET /api/research` includes `sourceUrl`, `snippet`, `listenChannel`.
4. Quality scores are not all 0% when sources exist.

Background Jobs **Degraded** with a Prisma error in the latest FailedJob means the research worker can fail persist/query even when Redis is up — treat that as worker reliability, not “no sources.”
