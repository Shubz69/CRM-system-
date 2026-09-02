# Platform Admin QA identity (safe provisioning)

**Do not** use a personal owner credential in committed Playwright tests.
**Do not** manufacture a platform-admin user in production from CI.

## Supported safe methods

### A. Dedicated QA platform admin (recommended)

1. Choose a **non-personal** mailbox (e.g. `platform-qa+agentdesk@yourdomain`).
2. Set env (locally / operator shell only — never commit):

```bash
export ADMIN_EMAIL="platform-qa+agentdesk@yourdomain"
export ADMIN_INITIAL_PASSWORD="<strong unique password>"
export ADMIN_FORCE_PASSWORD_CHANGE="true"
```

3. Against the **intended** database (`DATABASE_URL` / `DIRECT_URL`):

```bash
npm run seed:admin
```

This calls `seedSuperAdmin()` (`src/services/seed-admin.ts`):

- upserts the user with `isPlatformAdmin: true`
- attaches `SUPER_ADMIN` membership on the platform org (`dm-intelligence-platform`)
- never logs the password

4. Sign in once, complete forced password change at `/account/change-password`.
5. Store credentials only in operator secret store / `.env` (gitignored) as:

```text
E2E_PLATFORM_ADMIN_EMAIL=...
E2E_PLATFORM_ADMIN_PASSWORD=...
```

6. Re-run hosted acceptance:

```bash
$env:PLAYWRIGHT_SKIP_WEBSERVER="1"
$env:PLAYWRIGHT_BASE_URL="https://crm-system-eight-wine.vercel.app"
npx playwright test e2e/hosted-production-acceptance.spec.ts
```

Test 4 exercises:

- Admin nav visible
- `/admin` loads
- `GET /api/admin/workspaces` succeeds
- Workspace Administrator / Read Only still denied (tests 2–3)

### B. Hosted bootstrap (recovery / first admin)

`POST /api/admin/bootstrap` with header `x-admin-bootstrap-secret: $ADMIN_BOOTSTRAP_SECRET`.

Requires `ADMIN_INITIAL_PASSWORD` on the server. Prefer method A for a durable QA identity.

### C. Explicitly unsupported for automated E2E

- Reusing a founder’s personal login in committed tests
- Promoting a workspace `OWNER` / `ADMINISTRATOR` to platform admin via Team UI (workspace role changes cannot set `isPlatformAdmin`)

## Architecture reminder

| Flag / role | Scope |
|-------------|--------|
| `User.isPlatformAdmin` | Platform `/admin/*` + platform APIs |
| `MemberRole.SUPER_ADMIN` | Platform org membership |
| Workspace `OWNER` / `ADMINISTRATOR` | Tenant only — no `/admin` |

See also: `docs/ADMIN.md`.
