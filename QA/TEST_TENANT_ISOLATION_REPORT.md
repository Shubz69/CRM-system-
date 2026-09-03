# TEST TENANT ISOLATION REPORT

CURRENT_PLAYWRIGHT_ACTIVE=NO

SHOBHIT_AGENCY_MUTATIONS_STOPPED=YES

AUTOMATED_QA_ORG_EXISTS=NO

PLATFORM_ADMIN_BLOCKER=
(none for workspace list — Platform Admin login + GET /api/admin/workspaces returned 200). Mutating acceptance still blocked until disposable QA tenant + credentials + guard verification.

KNOWN_QA_ARTIFACTS_IN_SHOBHIT_AGENCY=
[list only, do not delete]

## Products (organisationId=cmsswt6gj0005ufy8jwbkvd47 / Shobhit Agency)
- product | cmtknv3wy0007jr041npd2ig6 | Aura Terminal UI 1788387686070 | createdAt=2026-09-02T22:21:43.954Z | evidence=acceptance-bp-defect-recheck uiExactPath + live GET /api/business-context
- product | cmtknuzx2000pie0a6ec37om5 | Aura Terminal | createdAt=2026-09-02T22:21:38.774Z | evidence=acceptance-bp-defect-recheck duplicateAura + live API
- product | cmtknuwhm0005jr044q71ljpc | Aura Terminal | createdAt=2026-09-02T22:21:34.331Z | evidence=acceptance-bp-defect-recheck exactCreate.c2 + live API
- product | cmtknuw04000nie0agbbscrfy | Agent Desk | createdAt=2026-09-02T22:21:33.623Z | evidence=acceptance-bp-defect-recheck exactCreate.c1 + live API
- product | cmtknrhxt000jie0arbtzo0br | Batch Product 3 1788387450614 | createdAt=2026-09-02T22:18:55.506Z | evidence=acceptance-resume-probe batchPersisted + live API
- product | cmtknrhjz0001jo0467jfdfeu | Batch Product 2 1788387450614 | createdAt=2026-09-02T22:18:55.007Z | evidence=acceptance-resume-probe batchPersisted + live API
- product | cmtknrh2f000hie0apb9i53cj | Batch Product 1 1788387450614 | createdAt=2026-09-02T22:18:54.375Z | evidence=acceptance-resume-probe batchPersisted + live API
- product | cmtknrb8d000die0aps4dmf89 | Third Product QA 1788387450614 | createdAt=2026-09-02T22:18:46.813Z | evidence=acceptance-resume-probe uiCreate + live API
- product | cmtknr0gw0005ie0aqfjbw2ez | Aura Terminal QA 1788387450614 | createdAt=2026-09-02T22:18:32.785Z | evidence=acceptance-resume-probe create2 + live API
- product | cmtknqsys0003ie0a8oed5b9n | Agent Desk QA Product 1788387450614 | createdAt=2026-09-02T22:18:23.141Z | evidence=acceptance-resume-probe create1 + live API

## Companies
- company | cmtko3cge0001jg0ax18dblql | Northstar Ops Ltd 1788388042953 | createdAt=2026-09-02T22:28:08.271Z | evidence=QA/run-acceptance-phases-3-42.mjs (killed mid-run) + live GET /api/companies
- company | cmtknqgqm0001ki0aylkrltwr | E2E-tenant-probe-1788387485726 | createdAt=2026-09-02T22:18:07.294Z | evidence=hosted-production-acceptance tenant probe + live API
- company | cmtkie0850005ji049djdqho1 | E2E-tenant-probe-1788378506561 | createdAt=2026-09-02T19:48:27.942Z | evidence=E2E-tenant-probe name pattern + live API
- company | cmtgefvui0001kz045jri1ovo | E2E-tenant-probe-1788130011372 | createdAt=2026-08-30T22:46:52.410Z | evidence=E2E-tenant-probe name pattern + live API
- company | cmtkjgd500017l304x44y1sys | Alison Calder - | createdAt=2026-09-02T20:18:17.604Z | evidence=weak-validation companyName from acceptance script pattern ("Alison Calder -"); SUSPECT — confirm before cleanup

## Deals
- deal | cmtko3e1s0001gt0a79y361hu | Northstar FDE Pilot 1788388042953 | createdAt=2026-09-02T22:28:10.336Z | evidence=QA/run-acceptance-phases-3-42.mjs + live GET /api/deals

## Content
- content | cmtkey66h0001jk0ak5mjwlx1 | QA Smoke Test Post - Agent Desk Production Acceptance | createdAt=2026-09-02T18:12:10.313Z | evidence=production-acceptance-probe2 Phase 9 publishing smoke + live GET /api/content

## Orgs created by acceptance (not Shobhit Agency records, but QA residue)
- organisation | cmtko2ihw0002lb04ie3frui6 | Agent Desk New Business QA 1788388042953 | createdAt=2026-09-02T22:27:29.445Z | evidence=Platform Admin create_beta from run-acceptance-phases-3-42.mjs (NOT "Agent Desk Automated QA")

## Notes
- Legitimate long-form product "Agent Desk - AI-powered CRM…" was present before contamination; not listed as QA artifact.
- No QA-named contacts/goals/knowledge documents found in live lists at inventory time (contact/goal creates from killed run may not have persisted).
- Aura Terminal multi-product persistence: do NOT treat prior save-failure reports as conclusive product defects — concurrent contamination on Shobhit Agency. Claude will retest; Playwright multi-product persistence must later run only inside Agent Desk Automated QA.

NEXT_REQUIRED_HUMAN_ACTION=
1. Create disposable org exactly named "Agent Desk Automated QA" (Platform Admin).
2. Create/configure QA workspace admin + read-only users on that org only.
3. Set local env (names only): E2E_TARGET_ORG_ID, E2E_TARGET_ORG_NAME=Agent Desk Automated QA, E2E_ALLOW_MUTATIONS=true, plus E2E_ADMIN_*/E2E_READONLY_* for the QA tenant.
4. Verify mutation safety guard fail-closed on Shobhit Agency, then allow-path on QA org.
5. Only then resume mutating acceptance (phases 3–42) — do not resume now.
6. Later: human-approved cleanup of KNOWN_QA_ARTIFACTS_IN_SHOBHIT_AGENCY (inventory only today).
