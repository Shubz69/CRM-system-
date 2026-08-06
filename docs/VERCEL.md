# Deploy on Vercel

This app is a Next.js frontend + API that deploys cleanly to Vercel. Postgres must be hosted separately (Neon, Supabase, Railway, etc.).

## One-click connect (recommended)

1. Open [vercel.com/new](https://vercel.com/new)
2. Import **`Shubz69/CRM-system-`** from GitHub
3. Framework preset: **Next.js** (uses `vercel.json`)
4. Set Environment Variables (Production + Preview) before the first **runtime** request.
   The build can compile without them (placeholders are used during `next build` only),
   but the live app will fail until at least these are set:

| Variable | Notes |
|----------|--------|
| `DATABASE_URL` | **Required at runtime.** Pooled Postgres URL (Neon “pooled” recommended) |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | `openssl rand -base64 32` |
| `NEXTAUTH_URL` | `https://YOUR_PROJECT.vercel.app` |
| `APP_URL` | Same as `NEXTAUTH_URL` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` (64 hex chars) |
| `MANYCHAT_WEBHOOK_SECRET` | Strong random (not `dev-*`) |
| `BOOKING_WEBHOOK_SECRET` | Strong random (not `dev-*`) |
| `DEMO_MODE` | `true` for demo staging; `false` for real prod |
| `AI_PROVIDER` | `mock` until keys exist |
| `CRON_SECRET` | Protects `/api/cron` |
| `REDIS_URL` | Optional; cron route covers follow-ups without Redis |
| `ADMIN_EMAIL` | Super admin email (e.g. `1230shobhit@gmail.com`) |
| `ADMIN_INITIAL_PASSWORD` | Strong password — **server-only**, never expose to client |
| `ADMIN_FORCE_PASSWORD_CHANGE` | `true` recommended |
| `ADMIN_BOOTSTRAP_SECRET` | Random 16+ char secret to unlock one-time admin seed API |

> Tip: In Vercel → Settings → Environment Variables, add `DATABASE_URL` for Production + Preview, then Redeploy.

5. Deploy
6. After first deploy, sync schema and create the super admin:

```bash
# Option A — from your machine against the hosted DB
DATABASE_URL="…" npx prisma db push
ADMIN_EMAIL=1230shobhit@gmail.com ADMIN_INITIAL_PASSWORD='…' npm run seed:admin

# Option B — bootstrap API after env vars are set (password stays in Vercel env)
curl -X POST "https://YOUR_DEPLOYMENT.vercel.app/api/admin/bootstrap" \
  -H "x-admin-bootstrap-secret: YOUR_ADMIN_BOOTSTRAP_SECRET"
```

Check status (no secrets returned):

```bash
curl "https://YOUR_DEPLOYMENT.vercel.app/api/admin/bootstrap"
```

Then sign in at `/login` with `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD`. Rotate or remove `ADMIN_BOOTSTRAP_SECRET` after success.

7. In Vercel → Settings → Domains, confirm the production URL matches `NEXTAUTH_URL` / `APP_URL`.

**Why login fails on a fresh preview:** the admin user is not created until you seed/bootstrap against the **Vercel** database. Seeding on your laptop only updates your local DB.

## CLI (optional)

```bash
npm i -g vercel
vercel login
vercel link
vercel env pull .env.local
vercel --prod
```

## Git branch

Connect the Vercel project to `main` for production, or to `cursor/frontend-vercel-deploy-668b` while reviewing this PR.

## Install note (Windows Postgres package)

`@embedded-postgres/windows-x64` is **not** listed in `package.json` because it breaks Linux/Vercel installs (`EBADPLATFORM`). Use Neon/Supabase/`DATABASE_URL` on Vercel. For local embedded Postgres only, install the platform package manually (see README).
