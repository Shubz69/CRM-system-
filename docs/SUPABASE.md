# Supabase (recommended Postgres host)

DM Intelligence uses **Prisma + PostgreSQL**. For Vercel and long-term production, use **[Supabase](https://supabase.com)** as the database.

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

5. Also keep a **direct** connection (port **5432**) for migrations/`db push` from your laptop if the pooler rejects migrate commands:

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

> Paste your real password (URL-encode special characters like `@` → `%40`).

## Step 3 — Add `DATABASE_URL` in Vercel

1. Open: https://vercel.com/shobhit-singhs-projects-c3f665ca/crm-system/settings/environment-variables  
2. **Add Environment Variable**  
   - **Key:** `DATABASE_URL`  
   - **Value:** Supabase **pooled** URI (port `6543`, with `pgbouncer=true`)  
   - Environments: **Production** + **Preview**  
3. Save.

## Step 4 — Apply the schema (from your laptop)

Use the **direct** (port `5432`) URL for this step:

```bash
cd /path/to/CRM-system-
export DATABASE_URL="postgresql://postgres.[REF]:[PASSWORD]@db.[REF].supabase.co:5432/postgres?sslmode=require"
npx prisma db push
export ADMIN_EMAIL="1230shobhit@gmail.com"
export ADMIN_INITIAL_PASSWORD="your-password-matching-vercel"
export ADMIN_FORCE_PASSWORD_CHANGE=true
npm run seed:admin
```

Optional demo data:

```bash
DEMO_MODE=true DATABASE_URL="…" npm run db:seed
```

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
