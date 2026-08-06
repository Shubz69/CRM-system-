# Security

## Secrets

Never commit production secrets. Never log passwords, access tokens, or full webhook secrets.

- Passwords: bcrypt (cost 12)
- Integration secrets at rest: AES-256-GCM via `ENCRYPTION_KEY`
- Admin initial password: `ADMIN_INITIAL_PASSWORD` env only

## Auth controls

- Secure login / logout (NextAuth JWT)
- Forced password change (`mustChangePassword`)
- Password reset with hashed tokens
- Login lockout after repeated failures
- Role + permission checks on every API (`requirePermission` / `requirePlatformAccess`)
- Webhook rate limiting
- Idempotent webhook processing

## Roles

`SUPER_ADMIN`, `OWNER`/`ADMIN`, `MANAGER`, `SALES_AGENT`, `VIEWER` (see `src/lib/permissions.ts`).

## Messaging compliance

Automated outbound messages check the 24h Instagram messaging window before send. Follow-ups are cancelled with a reason when blocked.

## Health endpoints

- `GET /api/health` — overall
- `GET /api/health/database` — DB only
- `GET /api/health/providers` — adapter status without secrets
