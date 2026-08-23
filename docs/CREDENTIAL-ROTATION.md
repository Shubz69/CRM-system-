# Credential rotation (operator manual)

**Code cannot rotate provider secrets for you.** This document lists what operators must rotate in Vercel / host / provider consoles. Agent Desk will never print or commit secret values.

Assume any previously shared `.env` contents require **external manual rotation**. The application only validates that defaults are not used in production.

---

## Must rotate if ever exposed

| Secret | Where | Notes |
|--------|--------|------|
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | Vercel + worker host | Session signing. Rotate → users re-login. |
| `MANYCHAT_WEBHOOK_SECRET` | Vercel + ManyChat webhook config | Production hard-fails if still default. |
| `BOOKING_WEBHOOK_SECRET` | Vercel + booking provider | Production hard-fails if still default. |
| `CRON_SECRET` | Vercel cron headers | If used. |
| `ANTHROPIC_API_KEY` and other AI keys | Vercel + worker | Rotate in Anthropic/OpenAI consoles first. |
| `MANYCHAT_API_TOKEN` | Vercel / IntegrationCredential | Per-workspace secrets in DB are encrypted. |
| Social OAuth app secrets (`INSTAGRAM_APP_SECRET`, `LINKEDIN_CLIENT_SECRET`, `TIKTOK_CLIENT_SECRET`) | Vercel + Meta/LI/TT developer apps | Reconnect tenant accounts after app secret change. |
| `APIFY_TOKEN`, `YOUTUBE_API_KEY`, `TAVILY_API_KEY`, … | Vercel + worker | Research adapters. |
| `DATABASE_URL` / `DIRECT_URL` | Vercel + worker + Supabase | Prefer pooler URL for app; rotate DB password in Supabase. |
| `REDIS_URL` | Vercel + worker + Upstash | Rotate Upstash credentials. |

---

## ENCRYPTION_KEY — do not casually rotate

`ENCRYPTION_KEY` (64 hex chars) encrypts `IntegrationCredential` / `SocialConnectionCredential` ciphertext.

**Changing this key against existing rows without a re-encrypt migration makes all stored tokens unreadable.**

Safe process (future work — design before executing):

1. Add `ENCRYPTION_KEY_PREVIOUS` support or dual-decrypt.
2. Re-encrypt all credential rows under a maintenance job.
3. Drop previous key only after verification.
4. Record `lastRotatedAt` via `PATCH /api/security/credentials` `{ action: "mark_rotated" }` (metadata only).

Until that migration exists: generate a unique key **once** before first production secret storage, and never replace it in place.

---

## App checks (what code does)

- Production webhooks/worker call `assertProductionSecretsConfigured()` — fails closed on default webhook secrets, default `ENCRYPTION_KEY`, and ephemeral auth secrets.
- `.gitignore` ignores `.env*` (keeps `.env.example`).
- CI runs Gitleaks; never commit real `.env` files.
- `GET /api/security/credentials` returns **health metadata only** (no ciphertext).

---

## After rotating

1. Update Vercel (Production + Preview) and the worker host.
2. Redeploy app + restart worker.
3. Re-run connection tests in Integrations.
4. Optionally `PATCH /api/security/credentials` to record rotation time.
5. Confirm Ask / inbound webhooks / OAuth still work.
