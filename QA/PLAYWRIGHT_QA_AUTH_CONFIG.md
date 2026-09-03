# Playwright QA activation

**Stopped before full acceptance:** clean Playwright identity not available; tenant isolation incomplete.

## Clean identity attempt (2026-09-03)

| Field | Value |
|-------|--------|
| Candidate email | `auraterminal2002@gmail.com` |
| Available for invite | **NO** |
| Reason | Existing membership: Shobhit Agency **ADMINISTRATOR** |
| platformAdmin | false |

**Do not invite or reuse this identity.** See `QA/CLEAN_QA_ACCESS_REVOCATION_REPORT.md`.

## Safe identifiers (existing fixture — not clean isolation)

| Field | Value |
|-------|--------|
| QA email | `shobhit2069@gmail.com` |
| QA org name | Agent Desk Automated QA |
| QA org id | `cmtkp47vk0000l504gvfzi1sj` |
| Role | OWNER |
| Platform Admin | false |
| Env file | `.env` (gitignored) |
| Shobhit Agency membership | still READ_ONLY — isolation FAIL |

## Env

- `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` — current QA customer (not clean)
- `E2E_PLATFORM_ADMIN_*` — separate platform admin
- `E2E_TARGET_ORG_ID=cmtkp47vk0000l504gvfzi1sj`
- `E2E_TARGET_ORG_NAME=Agent Desk Automated QA`
- `E2E_ALLOW_MUTATIONS=true`
- `PLAYWRIGHT_BASE_URL=https://crm-system-eight-wine.vercel.app`
- `PLAYWRIGHT_SKIP_WEBSERVER=1`

## READY_FOR_FULL_ACCEPTANCE=NO
