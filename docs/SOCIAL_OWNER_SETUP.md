# SOCIAL_OWNER_SETUP

Owner actions only. Do not paste secrets into chat, git, or tickets.

Publishing, DMs, follows, and live account connects are **off** until you complete these steps and explicitly approve an external action.

Callbacks (production host `https://crm-system-eight-wine.vercel.app`):

- Instagram: `/api/social/instagram/callback`
- LinkedIn: `/api/social/linkedin/callback`
- TikTok: `/api/social/tiktok/callback`
- Meta Instagram (messaging product): `/api/integrations/meta-instagram/callback`
- Zernio: `/api/integrations/zernio/callback`

Set the same values on **Vercel (preview + production)** and **Railway preview worker**.

## Instagram

| Field | Status |
|---|---|
| IMPLEMENTED | YES (native Graph + Zernio/Ayrshare path) |
| NEEDS_APP_CREATION | Owner — Meta developer app |
| NEEDS_CLIENT_ID | `INSTAGRAM_APP_ID` |
| NEEDS_CLIENT_SECRET | `INSTAGRAM_APP_SECRET` |
| NEEDS_CALLBACK | `INSTAGRAM_REDIRECT_URI` |
| NEEDS_REVIEW | Meta App Review (`instagram_business_basic`, `instagram_business_content_publish`) |
| READ_SUPPORTED | YES (Apify listen + Graph after connect) |
| PUBLISH_SUPPORTED | YES after review + approval gate |
| DM_SUPPORTED | ManyChat channel only — not this OAuth feature |
| TOKEN_REFRESH | YES when stored as SocialConnection credentials |
| SECURE_STORAGE | Encrypted SocialConnectionCredential rows |
| APPROVAL_GATE | YES — no autonomous publish |

## LinkedIn

| Field | Status |
|---|---|
| IMPLEMENTED | YES (member feed via `w_member_social` + Zernio) |
| NEEDS_APP_CREATION | Owner — LinkedIn developer app |
| NEEDS_CLIENT_ID | `LINKEDIN_CLIENT_ID` |
| NEEDS_CLIENT_SECRET | `LINKEDIN_CLIENT_SECRET` |
| NEEDS_CALLBACK | `LINKEDIN_REDIRECT_URI` |
| NEEDS_REVIEW | Sign In + Share products are self-serve; company pages are not in scope |
| READ_SUPPORTED | YES (Apify listen) |
| PUBLISH_SUPPORTED | Personal profile only, after connect + approval |
| DM_SUPPORTED | NO (no compliant third-party DM API) |
| TOKEN_REFRESH | YES |
| SECURE_STORAGE | Encrypted credentials |
| APPROVAL_GATE | YES |

## TikTok

| Field | Status |
|---|---|
| IMPLEMENTED | YES (Content Posting API + Zernio) |
| NEEDS_APP_CREATION | Owner — TikTok for Developers |
| NEEDS_CLIENT_ID | `TIKTOK_CLIENT_KEY` |
| NEEDS_CLIENT_SECRET | `TIKTOK_CLIENT_SECRET` |
| NEEDS_CALLBACK | `TIKTOK_REDIRECT_URI` |
| NEEDS_REVIEW | Login Kit + Content Posting API; verify pull-from-url domain |
| READ_SUPPORTED | YES (Apify listen) |
| PUBLISH_SUPPORTED | YES after review + approval |
| DM_SUPPORTED | NO |
| TOKEN_REFRESH | YES |
| SECURE_STORAGE | Encrypted credentials |
| APPROVAL_GATE | YES |

## YouTube / Shorts

| Field | Status |
|---|---|
| IMPLEMENTED | Listen via `YOUTUBE_API_KEY`; publish via Zernio network mapping |
| NEEDS_APP_CREATION | Owner — Google Cloud YouTube Data API + Zernio YouTube connect |
| NEEDS_CLIENT_ID | Zernio dashboard (not a native Google OAuth env in this checklist) |
| NEEDS_CALLBACK | `/api/integrations/zernio/callback` |
| READ_SUPPORTED | YES when `YOUTUBE_API_KEY` is set |
| PUBLISH_SUPPORTED | Zernio path only; never auto-publish |
| DM_SUPPORTED | NO |
| APPROVAL_GATE | YES |

Full UI/connect flow: `docs/SOCIAL_CONNECTIONS.md`.
