# CLEAN QA + ACCESS REVOCATION REPORT

```
CLEAN_QA_EMAIL_AVAILABLE=NO
CLEAN_QA_ORG=
CLEAN_QA_ROLE=
CLEAN_QA_PLATFORM_ADMIN=

TEAM_REMOVE_REPRODUCED=YES
TEAM_REMOVE_ROOT_CAUSE=Server remove works (PATCH action=remove deletes membership + audit). Prior "silent" UI failures most consistent with window.confirm dismiss / missing client try-catch; wrong active org yields toast "Member not found". Production session gap: JWT trusts org claims without live membership check on most APIs (up to ~5 min recheck).
SESSION_REVOCATION_STATUS=PARTIAL_ON_PRODUCTION_FIXED_LOCALLY

HYDRATION_418_REPRODUCED=NO
HYDRATION_418_ROOT_CAUSE=Not reproduced this run on Settings→Team. Likely candidate was invite expiry toLocaleDateString() locale SSR/client drift (fixed to stable ISO YYYY-MM-DD without suppressHydrationWarning). Distinct from Team Remove breakage.

KPI_DEFECT_STATUS=CONFIRMED_FIXED_LOCALLY
KNOWLEDGE_MODEL_DEFECT_STATUS=CONFIRMED_FIXED_LOCALLY
PROVIDER_LEAK_STATUS=CONFIRMED_FIXED_LOCALLY
BUSINESS_CONTEXT_MAPPING_STATUS=CONFIRMED_FIXED_LOCALLY
ACTIVE_ORG_ISOLATION_STATUS=NOT_CROSS_COOKIE_LEAK_MEMBERSHIP_CONTAMINATION

CODE_CHANGES_REQUIRED=YES
```

## 1. Clean identity precheck (STOP)

**Email:** `auraterminal2002@gmail.com`  
**Result:** NOT clean — do not invite / reuse.

| Field | Live value |
|-------|------------|
| userExists | true |
| platformAdmin | false |
| memberships | **1** — Shobhit Agency (`cmsswt6gj0005ufy8jwbkvd47`) as **ADMINISTRATOR** |
| organisations=NONE | **NO** |

**STOP reason:** Already in another org (Shobhit Agency ADMINISTRATOR). Per brief: do not reuse contaminated identity.

Artifacts: `QA/clean-identity-precheck.json`

**Invite / env switch to this email:** NOT DONE.  
**Password STOP for Shobhit:** N/A for this email (invite blocked). Existing QA customer remains `shobhit2069@gmail.com` (OWNER on Automated QA + contaminated READ_ONLY on Shobhit Agency).

## 2–3. Invite + local env

Skipped invite. Local `.env` still points mutating vars at existing Automated QA OWNER (`shobhit2069@gmail.com`) with:

- `E2E_TARGET_ORG_ID=cmtkp47vk0000l504gvfzi1sj`
- `E2E_TARGET_ORG_NAME=Agent Desk Automated QA`
- `E2E_ALLOW_MUTATIONS=true`

**Need from Shobhit:** a truly clean mailbox with **zero** memberships and `platformAdmin=false`, then invite as OWNER to Automated QA only (no platform admin).

## 4. Tenant isolation (blocked on clean identity)

Cannot prove clean isolation as `auraterminal2002` (contaminated).

Current Automated QA members snapshot (`QA/qa-org-members-snapshot.json`):

- Only `shobhit2069@gmail.com` OWNER on Automated QA
- Same user still has **READ_ONLY** on Shobhit Agency → isolation FAIL for that fixture

Do **not** remove Shobhit Agency membership until revoke/session fix is deployed and proven.

## 5–6. P0 Team Remove — live repro (Automated QA only)

Repro artifact: `QA/team-remove-repro.json`  
Disposable membership only inside **Agent Desk Automated QA** (never Shobhit Agency).

| Step | Result |
|------|--------|
| Invite READ_ONLY disposable | HTTP 200 |
| Accept invite | HTTP 200 |
| Victim access before remove | contacts 200 |
| PATCH remove | HTTP 200, `ok`+`removed` |
| Member gone from list | YES |
| Victim orgs after remove | empty (QA not listed) |
| Victim contacts after remove | **still HTTP 200** on production |
| Victim members API | 403 |

**Root cause (confirmed):**

1. **Delete path works** — `removeMember` hard-deletes `OrganisationMember`, writes `workspace.member.remove` audit, retargets `activeOrganisationId`.
2. **Session revocation incomplete on production** — JWT strategy; no live membership check in `requireSession`; workspace recheck only every ~5 minutes. Open session retains tenant API access (contacts) after remove.
3. **Silent UI** — Settings used bare `window.confirm` + no try/catch around `res.json()`; confirm-cancel looks like a silent failure (especially under automation without dialog handlers).

**Local fix (not deployed):**

- `src/lib/session.ts` — `requireSession` calls `assertActiveWorkspaceAccess` (immediate UNAUTHORIZED if membership gone)
- `src/app/(app)/settings/page.tsx` — try/catch + busy state on Remove/role change; stable invite expiry date format
- Tests: `tests/session-membership-revoke.test.ts`, READ_ONLY remove case in `tests/workspace-onboarding.test.ts`

Leftover invite from failed first attempt revoked: `QA/team-remove-invite-cleanup.json`.

## 7. Hydration #418

- **Reproduced:** NO (Settings → Team, production, this run)
- **Classification:** Separate from Remove breakage
- **Hardening:** Replaced `toLocaleDateString()` with ISO `YYYY-MM-DD` (no `suppressHydrationWarning`)

## 8–11. Other defects

| Defect | Status | Fix |
|--------|--------|-----|
| KPI silent partial save | CONFIRMED | Goals UI now requires goal + target and calls `attach_target` after `create_kpi` |
| Retired model `claude-sonnet-4-20250514` | CONFIRMED | `resolveCanonicalTierModel` breaks env self-loop; remaps to `claude-sonnet-4-6` |
| Anthropic/Claude leak in customer UI | CONFIRMED | System prompt → “Agent Desk…”; knowledge gap fallback → “Knowledge gap detected” |
| Business context audiences/markets | CONFIRMED | Checklist forms for audience + market claim (`operates_in_market`); markets no longer aliased to audience-only “partial” |
| Active workspace “leak” | DIAGNOSED | Not Playwright cookie cross-talk between different users; contamination is **membership** (QA user still on Shobhit Agency) + shared `User.activeOrganisationId` preference. Separate contexts for different users are isolated. |

## 12. BP multi-product

**TEST CONTENTION / INCONCLUSIVE** on prior Shobhit Agency runs.  
**Rule:** retest CRUD **only** inside Agent Desk Automated QA (`cmtkp47vk0000l504gvfzi1sj`) after a clean OWNER identity exists.

## 13. Acceptance strategy

- All ordinary mutating CRUD → **Agent Desk Automated QA only**
- `shobhit2069` = regression fixture only until Shobhit Agency READ_ONLY membership is removed **after** revoke fix is deployed + proven
- Do **not** resume full 42-phase acceptance with shobhit2069 as primary mutator while dual-membership remains
- Fail closed: `E2E_ALLOW_MUTATIONS` + exact `E2E_TARGET_ORG_*` required (`e2e/helpers/tenant-safety.ts`)

## 14. Quality gate + SHA

| Gate | Result |
|------|--------|
| typecheck | PASS (`tsc --noEmit`) |
| lint | 0 errors (pre-existing warnings only) |
| npm test | 715 passed; 1 unrelated env flake: `tests/adapters-extended.test.ts` mock email (real SMTP from local `.env` bypasses mock log) |
| Focused revoke/model tests | PASSED (23/23 across revoke + retired-model + onboarding) |
| Deploy | **NOT done** (per instructions) |

**BASE_SHA (origin/main HEAD):** `d012df295669e6b25f0a07edf374e25b67bcffcd`  
**CODE_UNCOMMITTED:** YES — fixes are local working tree only (no commit/deploy). New commit SHA will appear after Shobhit asks to commit.

### Files changed (this workstream)

- `src/lib/session.ts`
- `src/lib/ai-models.ts`
- `src/adapters/ai/index.ts`
- `src/services/inbound-pipeline.ts`
- `src/app/(app)/settings/page.tsx`
- `src/app/(app)/goals/page.tsx`
- `src/app/(app)/business-context/page.tsx`
- `src/services/digital-twin/index.ts`
- `tests/session-membership-revoke.test.ts` (new)
- `tests/retired-model-webhook-terminal.test.ts`
- `tests/workspace-onboarding.test.ts`

### Blockers for Shobhit

1. Provide a **clean** QA email (no memberships, not platform admin) — `auraterminal2002@gmail.com` is **not** eligible.
2. After invite + password self-setup, switch local `E2E_ADMIN_*` / `E2E_EMAIL` to that identity.
3. Deploy session membership gate before removing any real Shobhit Agency memberships.
4. Only then remove QA fixture’s Shobhit Agency READ_ONLY (never before prove).
