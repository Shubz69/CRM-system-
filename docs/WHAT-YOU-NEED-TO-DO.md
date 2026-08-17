# What you need to do manually

This is the only list of steps **you** have to do. Code, UI, colours, broken links, Ask permissions, inbox deep-links, Docker image, and research parsing are already fixed in the repo. Playwright can check the public pages without credentials; signed-in walks need the values below.

## 1. Create `.env`

From the project folder (`CRM-system--main`):

```powershell
copy .env.example .env
```

Then open `.env` and set **real** values. Do not leave the example placeholders.

### Must set (app will not work without these)

| Variable | What to put |
|---|---|
| `DATABASE_URL` | Postgres connection string. Local Docker: `postgresql://dmintel:dmintel@localhost:5432/dm_intelligence_crm?schema=public` |
| `DIRECT_URL` | Same as `DATABASE_URL` locally. On Supabase, use the **direct** (port 5432) URI, not the pooler. |
| `AUTH_SECRET` | Long random string. PowerShell: `[guid]::NewGuid().ToString() + [guid]::NewGuid().ToString()` |
| `NEXTAUTH_SECRET` | Same as `AUTH_SECRET` |
| `NEXTAUTH_URL` | `http://localhost:3000` locally, or your Vercel URL in production |
| `APP_URL` | Same as `NEXTAUTH_URL` |
| `ENCRYPTION_KEY` | 64 hex characters. Git Bash: `openssl rand -hex 32` |
| `ADMIN_EMAIL` | The email you will sign in with |
| `ADMIN_INITIAL_PASSWORD` | A strong password you will change on first login |
| `ADMIN_BOOTSTRAP_SECRET` | 16+ character secret if you use `/api/admin/bootstrap` on Vercel |

### Must set for Home / Research to actually run

| Variable | What to put |
|---|---|
| `REDIS_URL` | Local Docker: `redis://localhost:6379` |
| `AI_PROVIDER` | `anthropic` for real research, or `mock` for local UI testing |
| `ANTHROPIC_API_KEY` | Your Anthropic key. Research, Ask, and setup assistant stay mock/empty without this |

YouTube / Reddit / web search keys (see `.env.example`) are what make **research citations** appear. If they are unset, Ask will still run but the brief will say sources were not configured.

### Optional (features stay closed until you set them)

| Variable | Needed for |
|---|---|
| `APIFY_TOKEN` | Instagram / LinkedIn / TikTok listening |
| `MANYCHAT_API_TOKEN` + `MANYCHAT_WEBHOOK_SECRET` | Live Instagram DMs |
| `ASSET_STORAGE` + blob/S3 creds + `IMAGE_PROVIDER` | “Make an image” on Home |
| `EMAIL_SMTP_URL` | Password-reset emails in production (dev shows a reset link on screen) |
| `GOOGLE_SHEETS_*` | Export reports to Sheets |
| `E2E_EMAIL` / `E2E_PASSWORD` | Playwright signed-in walk |

## 2. Start the database and Redis

Docker Desktop must be running.

```powershell
docker compose up -d
```

The Postgres image is now `pgvector/pgvector:pg16` (required for knowledge search). If you already had an old `postgres:16-alpine` volume, reset it once:

```powershell
docker compose down -v
docker compose up -d
```

That **wipes local Docker data**. Do not run `-v` against a production database.

## 3. Apply schema and create your workspace

```powershell
npx prisma migrate deploy
npm run db:seed
$env:ADMIN_EMAIL="you@example.com"
$env:ADMIN_INITIAL_PASSWORD="your-strong-password"
npm run seed:admin
npx tsx scripts/create-organisation.ts --name "Your Agency" --slug your-agency --owner-email you@example.com
```

Seed alone only creates the **platform** org. Inbox / Pipeline stay empty until you create a tenant workspace (command above, or Admin → Workspaces after login as platform admin).

## 4. Run the app and the worker

Two terminals:

```powershell
npm run dev
```

```powershell
npm run worker
```

Home → Research **queues a job in Redis**. Without the worker, Ask stays on “Starting…” / Pending forever.

Open http://localhost:3000 → Sign in → change password if prompted → Home.

## 5. Confirm research

On Home, type something like:

`Research plant hire pricing in the UK`

You should see progress, then a summary plus sourced findings (not a JSON dump). If it says sources were not configured, add the YouTube/Reddit/web keys from `.env.example` and restart `npm run dev` and `npm run worker`.

## 6. Playwright (optional, after login works)

```powershell
npx playwright install chromium
$env:E2E_EMAIL="you@example.com"
$env:E2E_PASSWORD="your-password"
npx playwright test
```

Without `E2E_EMAIL` / `E2E_PASSWORD`, only public-page tests run (landing, login, forgot-password).

## 7. Hosted deploy (Vercel + Supabase)

Follow `docs/SUPABASE.md` and `docs/VERCEL.md`. Set the same env vars in Vercel. On production:

- Use `npx prisma migrate deploy` — never `npm run db:setup` / `prisma db push`
- Replace all `dev-*` webhook secrets
- Set a real `ENCRYPTION_KEY` (not the example)
- Run a worker somewhere Redis can reach (`docs/WORKER.md`), or Ask will not complete
- Password reset needs `EMAIL_SMTP_URL` or users cannot recover accounts

## What is already fixed in code (you do not need to do these)

- New ink + teal colour system on every page
- Single page title in the shell (no duplicate H1s)
- Notifications bell actually opens `/api/notifications`
- Inbox opens the right conversation from Needs Attention (`?c=` and `?conversationId=`)
- Sales agents can use Home / Ask (`ask:use` permission)
- Workspace owners are no longer treated as platform admins
- Docker Postgres image includes pgvector
- Research query expansion is more tolerant of messy Claude JSON
- Ask results show findings and sources as cards, not raw JSON
- Reports / automations / setup no longer dump JSON as the main UI
- Infinite “Loading…” on agent and contact detail now shows an error + retry
