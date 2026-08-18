# Social Connections (Instagram / LinkedIn / TikTok)

Lets a tenant connect their **own** Instagram, LinkedIn, or TikTok account from
**Settings → Integrations → Social Connections**, so listening and publishing run
against their account, not a shared one. This is separate from:

- **ManyChat** (`docs/MANYCHAT.md`) — the existing Instagram DM channel. Messaging
  stays there; it is not part of this feature.
- **Apify listening** (`docs/INTEGRATIONS.md`, `src/adapters/sources`) — one shared
  `APIFY_TOKEN` scrapes public Instagram/LinkedIn/TikTok content for research. The
  "Listen" badge on a connected platform reflects that this still works; it does not
  mean the org's own token is used for scraping.

## What each platform can actually do (checked against current platform docs, Aug 2026)

| Platform | Listen | Publish | Message |
|---|---|---|---|
| Instagram | Yes — Apify (already configured platform-wide) | Yes — Meta Graph API Content Publishing, once your Meta App passes App Review | Yes — via the existing **ManyChat** channel, not this feature |
| LinkedIn | Yes — Apify | Personal-profile posts only (`w_member_social`, free/self-serve). Company-page posting needs LinkedIn's enterprise Marketing Developer Platform (paid, slow approval, often rejected) | **Not available.** No compliant third-party DM API exists. Decided 2026-08-18: not building this — see the note at the bottom before revisiting |
| TikTok | Yes — Apify | Yes — official Content Posting API, once your TikTok app passes review | **Not available.** No official TikTok DM API exists for third parties at all |

The "Publish" and "Message" columns are about **this OAuth feature**. They are
enforced in code (`src/adapters/social/*.ts` — each adapter only requests the
scopes it actually needs) so the UI badges can never silently overstate what's
possible.

## 1. Instagram — Meta App (Instagram API with Instagram Login)

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) → create an app → add the **Instagram** product (the direct Instagram Login flow — no Facebook Page required).
2. Under the Instagram product's API setup, add an OAuth redirect URI:
   `{APP_URL}/api/social/instagram/callback`
3. Complete **Meta Business verification** for your Business Portfolio — required before Advanced Access is possible.
4. Submit **App Review** requesting `instagram_business_basic` and `instagram_business_content_publish` together (same submission, consistent use case, or Meta rejects the whole thing). You'll need a screencast of the connect flow and a written justification.
5. Once approved at Advanced Access, set in `.env` / Vercel:
   ```
   INSTAGRAM_APP_ID=
   INSTAGRAM_APP_SECRET=
   INSTAGRAM_REDIRECT_URI="https://your-app-url/api/social/instagram/callback"
   ```
6. From **Integrations**, click **Connect Instagram** and complete the consent screen with a real Instagram Business/Creator account.

Until App Review passes, the connect button still works for the app's own registered testers (Meta's sandbox mode) — useful for verifying the flow before going live.

## 2. LinkedIn — free consumer app

1. Go to [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps) → create an app.
2. Add the **"Sign In with LinkedIn using OpenID Connect"** and **"Share on LinkedIn"** products — both self-serve, no approval wait.
3. Add an authorized redirect URL: `{APP_URL}/api/social/linkedin/callback`
4. Set in `.env` / Vercel:
   ```
   LINKEDIN_CLIENT_ID=
   LINKEDIN_CLIENT_SECRET=
   LINKEDIN_REDIRECT_URI="https://your-app-url/api/social/linkedin/callback"
   ```
5. From **Integrations**, click **Connect LinkedIn**. Publishing posts to the connecting member's own feed — not a company page.

Company-page posting and any form of messaging require LinkedIn's enterprise Marketing Developer Platform (roughly $700+/month, 4-8+ week approval, frequently rejected) — not wired up here. If you want to pursue it later, that's a new, explicit decision (cost + timeline), not a code change.

## 3. TikTok — TikTok for Developers app

1. Go to [developers.tiktok.com](https://developers.tiktok.com/) → create an app.
2. Add the **Login Kit** and **Content Posting API** products.
3. Add a redirect URI: `{APP_URL}/api/social/tiktok/callback`
4. Under Content Posting API settings, verify the domain that will host the video files you publish (Direct Post's `PULL_FROM_URL` requires a verified domain — otherwise publish calls fail even with a valid token).
5. Set in `.env` / Vercel:
   ```
   TIKTOK_CLIENT_KEY=
   TIKTOK_CLIENT_SECRET=
   TIKTOK_REDIRECT_URI="https://your-app-url/api/social/tiktok/callback"
   ```
6. Until your app passes TikTok's review, it stays **"unaudited"** — posts publish as private/self-view only (`privacy_level: SELF_ONLY`, already the default in `src/adapters/social/tiktok.ts`). That's intentional, not a bug: TikTok requires this for unreviewed apps.

No DM capability exists here or anywhere official for TikTok — nothing to configure.

## Verifying it worked

1. Set the env vars for whichever platform(s) you've set up, restart `npm run dev` (and redeploy on Vercel).
2. Open **Integrations** — the platform's card should show **"Connect {Platform}"** instead of **"Not set up yet"**.
3. Click it, complete the real consent screen, and confirm you land back on Integrations with a "connected" toast and the card showing your handle.
4. Tokens are stored encrypted (same `ENCRYPTION_KEY` / AES-256-GCM as every other credential in this app) in `SocialConnection` / `SocialConnectionCredential` — never logged, never returned to the browser.

## On LinkedIn/TikTok messaging

This was explicitly decided against on 2026-08-18: no unofficial provider (session-hijacking tools like Unipile work but violate those platforms' terms of service and risk the connected account being flagged or banned), and no LinkedIn enterprise application (slow, costly, frequently rejected). If this changes, treat it as a new decision with its own cost/risk tradeoff — don't quietly wire it in.
