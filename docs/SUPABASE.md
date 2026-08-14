# Supabase (recommended Postgres host)

Agent Desk uses **Prisma + PostgreSQL**. For Vercel and long-term production, use **[Supabase](https://supabase.com)** as the database.

Auth, AI, and ManyChat stay in this Next.js app. Supabase is the managed Postgres (and later you can add Storage / Realtime if needed).

## Step 1 — Create a Supabase project

1. Sign up / log in: https://supabase.com/dashboard  
2. **New project** → pick org, name (e.g. `dm-intelligence`), set a strong **database password**, choose a region close to you.  
3. Wait until the project is **Active**.

## Step 2 — Copy the connection string for Prisma

1. Open your project in the dashboard.  
2. Go to **Project Settings → Database**:  
   https://supabase.com/dashboard/project/_/settings/database  
3. Under **Connection string**, choose **URI**.  
4. Prefer the **Transaction** pooler (port **6543**) for Vercel serverless:

```text
postgresql://postgres.[PROJECT-REF]:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true
```

5. Also keep a **direct** connection (port **5432**) for `prisma migrate deploy` from your laptop if the pooler rejects migrate commands:

```text
postgresql://postgres.[PROJECT-REF]:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

Or use **Database → Connection string → Direct connection** from the settings page.

Add Prisma-friendly query params when needed:

```text
?schema=public&sslmode=require
```

For the **pooled** Vercel URL, a common working form is:

```text
postgresql://postgres.[REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
```

> Paste your real password (URL-encode special characters like `@` → `%40`, `^` → `%5E`, `!` → `%21`).

### Critical: avoid `EMAXCONNSESSION`

If the dashboard shows:

```text
FATAL: (EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15
```

your Vercel `DATABASE_URL` is using the **Session** pooler (port **5432**) under serverless load. Fix it:

1. In Supabase → **Project Settings → Database → Connection string** choose **Transaction** pooler (port **6543**).
2. Username form is usually `postgres.[PROJECT-REF]`.
3. Append `?pgbouncer=true&connection_limit=1`.
4. Also set **`DIRECT_URL`** to a direct/session URI (port **5432**) for `prisma db push` / migrations from your laptop.
5. Redeploy Vercel after saving env vars.

The app’s Prisma client reuses a single instance per isolate and will warn in production logs if it detects a session-pooler URL.

## Step 3 — Add `DATABASE_URL` in Vercel

1. Open: https://vercel.com/shobhit-singhs-projects-c3f665ca/crm-system/settings/environment-variables  
2. **Add Environment Variable**  
   - **Key:** `DATABASE_URL`  
   - **Value:** Supabase **Transaction** pooled URI (port `6543`, with `pgbouncer=true&connection_limit=1`)  
   - Environments: **Production** + **Preview**  
3. **Add** `DIRECT_URL` with the direct/session URI for migrations (not required by the Vercel runtime if unused there).  
4. Save and **redeploy**.

## Step 4 — Apply the schema (from your laptop)

Use the **direct** (port `5432`) URL for this step:

```bash
cd /path/to/CRM-system-
export DATABASE_URL="postgresql://postgres.[REF]:[PASSWORD]@db.[REF].supabase.co:5432/postgres?sslmode=require"
npx prisma migrate deploy
export ADMIN_EMAIL="1230shobhit@gmail.com"
export ADMIN_INITIAL_PASSWORD="your-password-matching-vercel"
export ADMIN_FORCE_PASSWORD_CHANGE=true
npm run seed:admin
```

```bash
export DATABASE_URL="…"
npm run db:seed   # platform organisation only
```

Create a tenant workspace with `npx tsx scripts/create-organisation.ts …` or Admin → Workspaces.

## Step 5 — Redeploy Vercel

https://vercel.com/shobhit-singhs-projects-c3f665ca/crm-system/deployments → latest → **Redeploy**

## Step 6 — Confirm + sign in

```bash
curl "https://YOUR-DEPLOYMENT.vercel.app/api/admin/bootstrap"
```

Expect `"databaseOk": true` and `"adminExists": true`.

Then open `/login` with `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD`.

## Useful Supabase links

| Task | Link |
|------|------|
| Dashboard | https://supabase.com/dashboard |
| Database settings | https://supabase.com/dashboard/project/_/settings/database |
| Table editor | https://supabase.com/dashboard/project/_/editor |
| SQL editor | https://supabase.com/dashboard/project/_/sql |
| Docs: connecting | https://supabase.com/docs/guides/database/connecting-to-postgres |

## Notes

- Do **not** put the Supabase `service_role` key in this app unless you later add Supabase Storage/Auth APIs; Prisma only needs `DATABASE_URL`.  
- Rotate the DB password in Supabase if it was exposed, then update Vercel `DATABASE_URL` and redeploy.  
- Local Docker/embedded Postgres remains fine for development; use Supabase for Preview + Production.
