# Deploy on Vercel

This app is a Next.js frontend + API that deploys cleanly to Vercel. Postgres must be hosted separately (Neon, Supabase, Railway, etc.).

## One-click connect (recommended)

1. Open [vercel.com/new](https://vercel.com/new)
2. Import **`Shubz69/CRM-system-`** from GitHub
3. Framework preset: **Next.js** (uses `vercel.json`)
4. Set Environment Variables (Production + Preview):

| Variable | Notes |
|----------|--------|
| `DATABASE_URL` | Pooled Postgres URL (Neon “pooled” recommended) |
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

5. Deploy
6. After first deploy, run migrations against the production DB:

```bash
DATABASE_URL="…" npx prisma migrate deploy
# or
DATABASE_URL="…" npx prisma db push
DEMO_MODE=true DATABASE_URL="…" npm run db:seed   # staging only
```

7. In Vercel → Settings → Domains, confirm the production URL matches `NEXTAUTH_URL` / `APP_URL`.

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

## Notes

- `@embedded-postgres/*` is Windows-local only and installed with `--force` on Vercel via `installCommand`.
- Long-running `npm run worker` is optional on Vercel; `/api/cron` runs follow-ups + insight aggregation every 5 minutes.
- Health check: `GET /api/health`
