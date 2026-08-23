# Security V2 / V3 Phase 11

Extends `docs/SECURITY.md`. Production schema: `migrate deploy` only.

## Phase 11 status (2026-08-23)

| Control | Status |
|---------|--------|
| Prod secret hard-fail (`assertProductionSecretsConfigured`) | Done — webhooks + worker boot |
| CI secret scanning (Gitleaks) | Done — `.github/workflows/ci.yml` |
| `.env` not committed | Done — `.gitignore` + CI check script |
| Credential health + rotation metadata | Done — additive columns + `/api/security/credentials` |
| ENCRYPTION_KEY live rewrite | **Forbidden** without migration — see `CREDENTIAL-ROTATION.md` |
| Webhook timestamp replay window | Done — optional headers; idempotency remains primary |
| PII-aware logging | Done — `logger` redacts secrets + email/phone patterns |
| SSRF-safe fetch | Done — `safeFetch` / `assertUrlSafeForServerFetch`; LinkedIn media URL uses it |
| Untrusted content boundaries | Done — `wrapUntrustedContent` / `stripInjectionMarkers` |
| Tool capability permissions | Kernel policy tests (outbound/publish require approval) |
| Tenant isolation regression | Existing + Phase 11 unit tests |

## Operator action required

Rotate any previously shared secrets **manually** in provider consoles + Vercel. Code does not claim rotation happened. Checklist: [`CREDENTIAL-ROTATION.md`](./CREDENTIAL-ROTATION.md).

## Still open (later phases)

- Full OTel / SSO / SCIM (Phase 18)
- Domain event outbox (Phase 12B)
- Broader SSRF on every adapter fetch of user URLs (LinkedIn media done; audit others)
