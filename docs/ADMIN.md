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

The seed is idempotent: it upserts the user, hashes the password with bcrypt cost 12, sets `isPlatformAdmin`, and ensures a `SUPER_ADMIN` membership on `demo-agency` (or creates `dm-intelligence-platform`). Console output is only `Super admin ready: <email>` — the password is never logged.

## First login

If `ADMIN_FORCE_PASSWORD_CHANGE` is not `"false"`, the user must visit `/account/change-password` before using the rest of the app. Middleware and `(app)/layout` enforce this.

## Admin console

Authenticated platform admins can open:

| Path | Purpose |
|------|---------|
| `/admin` | Platform counts |
| `/admin/users` | User list |
| `/admin/workspaces` | Organisations |
| `/admin/health` | DB/Redis/failed jobs |
| `/admin/webhooks` | Recent webhook events |
| `/admin/audit` | Audit trail |

## Account lockout

Credentials auth locks an account for 15 minutes after 5 failed login attempts. Suspended or inactive users cannot sign in.
