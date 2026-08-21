# Brand-new env setup (do this in order)

You do **not** need to Reveal old Vercel secrets. We generate secrets locally and you create fresh API keys from each provider.

Your local file: `.env` (already prepared with generated secrets).

---

## Step 0 — open the file

Open `.env` in Cursor. You will only edit lines that are empty or say `CHANGE_ME_TO_YOUR_PASSWORD`.

---

## Step 1 — login password (do this now)

In `.env` find:

```env
ADMIN_INITIAL_PASSWORD="CHANGE_ME_TO_YOUR_PASSWORD"
```

Replace with a password you will remember, e.g.:

```env
ADMIN_INITIAL_PASSWORD="MyStrongPassword123!"
```

Save.

**Already done for you:** `AUTH_SECRET`, `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`, `ADMIN_BOOTSTRAP_SECRET`, webhook secrets, database URLs, localhost URLs.

---

## Step 2 — Redis (pick ONE)

### Option A — Local Docker (simplest for now)

1. Install/start [Docker Desktop](https://www.docker.com/products/docker-desktop/)
2. Keep `REDIS_URL="redis://localhost:6379"` as-is in `.env`
3. Later we run `docker compose up -d`

### Option B — Upstash (cloud Redis, same as Vercel-style)

1. Open [https://console.upstash.com/](https://console.upstash.com/)
2. Sign in → **Create Database** → Redis
3. Copy the **Redis URL** (`rediss://default:...@....upstash.io:6379`)
4. Paste into `.env`:

```env
REDIS_URL="rediss://...."
```

---

## Step 3 — Anthropic (AI / Ask / research) — required for real AI

1. Open [https://console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Sign in / create account
3. **Create Key** → copy `sk-ant-...`
4. Paste into `.env`:

```env
ANTHROPIC_API_KEY="sk-ant-..."
AI_PROVIDER="anthropic"
```

**No Anthropic yet?** Use mock mode temporarily:

```env
AI_PROVIDER="mock"
ANTHROPIC_API_KEY=""
```

App UI works; research answers will be fake/local.

---

## Step 4 — Tavily (web research) — recommended

1. Open [https://app.tavily.com/home](https://app.tavily.com/home)
2. Sign up → **API Keys** → copy key
3. Paste:

```env
TAVILY_API_KEY="tvly-..."
WEB_SEARCH_PROVIDER="tavily"
```

Skip if you only want mock AI for now.

---

## Step 5 — YouTube Data API — recommended for research

1. Open [Google Cloud Console – YouTube API](https://console.cloud.google.com/apis/library/youtube.googleapis.com)
2. Select/create a project → **Enable** YouTube Data API v3
3. Go to [Credentials](https://console.cloud.google.com/apis/credentials)
4. **Create credentials** → **API key** → copy
5. Paste:

```env
YOUTUBE_API_KEY="AIza..."
```

---

## Step 6 — OpenAI (optional)

Only if you want OpenAI embeddings/images.

1. [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Create key → paste:

```env
OPENAI_API_KEY="sk-..."
EMBEDDING_PROVIDER="openai"
```

Otherwise leave:

```env
OPENAI_API_KEY=""
EMBEDDING_PROVIDER="none"
IMAGE_PROVIDER="none"
```

---

## Step 7 — Apify (optional — Instagram / LinkedIn / TikTok listening)

1. [https://console.apify.com/settings/integrations](https://console.apify.com/settings/integrations)
2. Create token → paste:

```env
APIFY_TOKEN="apify_api_..."
```

Leave empty until you need social listening.

---

## Step 8 — ManyChat (optional — live Instagram DMs)

1. Open [https://manychat.com](https://manychat.com) and sign in
2. Go to **Settings → API** (or [ManyChat API help](https://help.manychat.com/hc/en-us/articles/14281101935004))
3. Generate / copy API token → paste:

```env
MANYCHAT_API_TOKEN="..."
```

`MANYCHAT_WEBHOOK_SECRET` is already generated in `.env` — use that same value later in ManyChat webhook settings when you go live.

Leave token empty until go-live.

---

## Step 9 — Booking link (optional)

1. Create a scheduling link:
   - [Calendly](https://calendly.com/) or [Cal.com](https://cal.com/)
2. Paste your public booking URL:

```env
DEFAULT_BOOKING_URL="https://calendly.com/your-name/30min"
BOOKING_PROVIDER="link"
```

---

## Step 10 — Vercel Blob (optional — image generation storage)

1. [Vercel Dashboard](https://vercel.com/dashboard) → **Storage** → create **Blob**
2. Copy store id / token when shown
3. Only needed for “Make an image” — skip for now

---

## Minimum to run the CRM today

| Item | Status |
|------|--------|
| Database URLs | Done |
| Auth secrets | Done (generated) |
| `ADMIN_INITIAL_PASSWORD` | **You set this** |
| Redis | Local Docker URL preset |
| Anthropic | **You add key** OR set `mock` |
| Tavily / YouTube / ManyChat / Apify | Optional |

After Step 1 + (Step 3 or mock), tell me **“ready”** and I’ll start Docker, migrate, seed, and `npm run dev` for you.

---

## Important note about production Vercel

This is a **new local** setup. Secrets here are **not** the same as your old Vercel Sensitive vars.

- Local login uses `ADMIN_INITIAL_PASSWORD` after we seed.
- Production on Vercel keeps its own Sensitive env vars unchanged.
- If you later want local to match production encryption, you’d paste production `ENCRYPTION_KEY` instead — only do that if you intentionally share the same encrypted data.
