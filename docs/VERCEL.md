# Deploy on Vercel

This app is a Next.js frontend + API on Vercel. **Postgres is hosted on [Supabase](https://supabase.com)** (recommended for long-term production). Full database steps: [SUPABASE.md](./SUPABASE.md).

## One-click connect (recommended)

1. Open [vercel.com/new](https://vercel.com/new)
2. Import **`Shubz69/CRM-system-`** from GitHub
3. Framework preset: **Next.js** (uses `vercel.json`)
4. Create a Supabase project and copy the pooled `DATABASE_URL` — see [SUPABASE.md](./SUPABASE.md)
5. Set Environment Variables (Production + Preview) before the first **runtime** request.
   The build can compile without them (placeholders are used during `next build` only),
   but the live app will fail until at least these are set:

| Variable | Notes |
|----------|--------|
| `DATABASE_URL` | **Required.** Supabase Postgres URI (pooled port `6543` + `pgbouncer=true` for Vercel) |
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

Your project env UI:  
https://vercel.com/shobhit-singhs-projects-c3f665ca/crm-system/settings/environment-variables

6. Deploy / **Redeploy** after saving env vars:  
   https://vercel.com/shobhit-singhs-projects-c3f665ca/crm-system/deployments

7. Apply schema + seed admin against Supabase (use **direct** DB URL for `db push`):

```bash
DATABASE_URL="postgresql://postgres.[REF]:[PASSWORD]@db.[REF].supabase.co:5432/postgres?sslmode=require" \
  npx prisma db push
ADMIN_EMAIL=1230shobhit@gmail.com ADMIN_INITIAL_PASSWORD='…' npm run seed:admin
```

Or call the bootstrap API (password stays in Vercel env only):

```bash
curl -X POST "https://YOUR_DEPLOYMENT.vercel.app/api/admin/bootstrap" \
  -H "x-admin-bootstrap-secret: YOUR_ADMIN_BOOTSTRAP_SECRET"
```

Check status (no secrets returned):

```bash
curl "https://YOUR_DEPLOYMENT.vercel.app/api/admin/bootstrap"
```

Then sign in at `/login` with `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD`. Rotate or remove `ADMIN_BOOTSTRAP_SECRET` after success.

8. Confirm `NEXTAUTH_URL` / `APP_URL` match the live deployment URL (Domains in Vercel).

**Why login fails on a fresh preview:** the admin user is not created until you seed/bootstrap against the **Supabase** database. Seeding on your laptop with a local `DATABASE_URL` does not update Supabase.

## CLI (optional)

```bash
npm i -g vercel
vercel login
vercel link
vercel env pull .env.local
vercel --prod
```

## Git branch

Connect the Vercel project to `main` for production; preview deployments follow feature branches / PRs.

## Install note (Windows Postgres package)

`@embedded-postgres/windows-x64` is **not** listed in `package.json` because it breaks Linux/Vercel installs (`EBADPLATFORM`). Use **Supabase** `DATABASE_URL` on Vercel. For local embedded Postgres only, install the platform package manually (see README).
