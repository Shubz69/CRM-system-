# Super Admin

## Role and flags

- `MemberRole.SUPER_ADMIN` — platform-level role with all workspace and platform permissions (`platform:manage`, `users:manage`, `workspaces:manage`, `impersonate`, `system:health`).
- `User.isPlatformAdmin` — boolean flag also granting access to `/admin/*` pages.
- Workspace `OWNER` retains all organisation permissions but is not a platform admin unless also flagged.

## Seed the super admin

Never commit real passwords. Set env vars, then run:

```bash
export ADMIN_EMAIL="1230shobhit@gmail.com"
export ADMIN_INITIAL_PASSWORD="your-strong-password"
export ADMIN_FORCE_PASSWORD_CHANGE="true"
npm run seed:admin
```

The seed is idempotent: it upserts the user, hashes the password with bcrypt cost 12, sets `isPlatformAdmin`, and ensures a `SUPER_ADMIN` membership on `dm-intelligence-platform`. Console output is only `Super admin ready: <email>` — the password is never logged.

Create a real tenant workspace with:

```bash
npx tsx scripts/create-organisation.ts --name "Your Agency" --slug your-agency --owner-email "$ADMIN_EMAIL"
```

Or use **Admin → Workspaces** after signing in.

## First login

1. Open [http://localhost:3000/login](http://localhost:3000/login)
2. Sign in with `ADMIN_EMAIL` and `ADMIN_INITIAL_PASSWORD`
3. If `ADMIN_FORCE_PASSWORD_CHANGE` is not `"false"`, you must visit `/account/change-password` before using the rest of the app

## Admin console

| Path | Purpose |
|------|---------|
| `/admin` | Platform counts |
| `/admin/users` | User list |
| `/admin/workspaces` | Organisations |
| `/admin/usage` | AI & feature usage |
| `/admin/health` | DB/Redis/failed jobs |
| `/admin/failed-jobs` | Failed background jobs |
| `/admin/webhooks` | Recent webhook events |
| `/admin/audit` | Audit trail |
| `/admin/settings` | Global SystemSetting keys |

## Impersonation

`POST /api/admin/impersonate` records start/end in the audit log. Super admins cannot impersonate other platform admins. Passwords are never revealed.

## Password reset

- Request: `POST /api/auth/password-reset` with `{ email }`
- Complete: `POST /api/auth/password-reset` with `{ token, password }`
- UI: `/forgot-password` and `/reset-password?token=…`
- Production email: set `EMAIL_SMTP_URL` + `EMAIL_FROM` (nodemailer SMTP). Without SMTP, no inbox mail is sent.
- Ops recovery (no SMTP): on `/forgot-password`, open **No email yet? Use recovery secret**, paste `ADMIN_BOOTSTRAP_SECRET`, submit — the page shows a one-time reset link. Same secret via header `x-admin-bootstrap-secret`.
- Ensure `APP_URL` / `NEXTAUTH_URL` are the public site URL so the link points at production.

## Account lockout

After repeated failed logins the account is temporarily locked (`failedLoginAttempts` / `lockedUntil`). Successful login clears the counters.
