# TEST TENANT ISOLATION REPORT

CURRENT_PLAYWRIGHT_ACTIVE=NO

SHOBHIT_AGENCY_MUTATIONS_STOPPED=YES

AUTOMATED_QA_ORG_EXISTS=YES (Round 2 reference: Agent Desk Automated QA `cmtkp47vk0000l504gvfzi1sj` — mutations only; do not write new QA records into Shobhit Agency)

PLATFORM_ADMIN_BLOCKER=
(none for workspace list). Mutating acceptance still needs E2E_TARGET_ORG_* + guard verification on this machine.

KNOWN_QA_ARTIFACTS_IN_SHOBHIT_AGENCY=
[list only, do not delete]

## Products (organisationId=cmsswt6gj0005ufy8jwbkvd47 / Shobhit Agency)
- product | cmtknv3wy0007jr041npd2ig6 | Aura Terminal UI 1788387686070 | createdAt=2026-09-02T22:21:43.954Z | reason=acceptance-bp-defect-recheck | relationships=Business Profile products
- product | cmtknuzx2000pie0a6ec37om5 | Aura Terminal | createdAt=2026-09-02T22:21:38.774Z | reason=acceptance duplicate Aura | relationships=Business Profile products
- product | cmtknuwhm0005jr044q71ljpc | Aura Terminal | createdAt=2026-09-02T22:21:34.331Z | reason=acceptance exactCreate | relationships=Business Profile products
- product | cmtknuw04000nie0agbbscrfy | Agent Desk | createdAt=2026-09-02T22:21:33.623Z | reason=acceptance exactCreate | relationships=Business Profile products
- product | cmtknrhxt000jie0arbtzo0br | Batch Product 3 1788387450614 | createdAt=2026-09-02T22:18:55.506Z | reason=acceptance-resume-probe batch | relationships=Business Profile products
- product | cmtknrhjz0001jo0467jfdfeu | Batch Product 2 1788387450614 | createdAt=2026-09-02T22:18:55.007Z | reason=acceptance-resume-probe batch | relationships=Business Profile products
- product | cmtknrh2f000hie0apb9i53cj | Batch Product 1 1788387450614 | createdAt=2026-09-02T22:18:54.375Z | reason=acceptance-resume-probe batch | relationships=Business Profile products
- product | cmtknrb8d000die0aps4dmf89 | Third Product QA 1788387450614 | createdAt=2026-09-02T22:18:46.813Z | reason=acceptance-resume-probe uiCreate | relationships=Business Profile products
- product | cmtknr0gw0005ie0aqfjbw2ez | Aura Terminal QA 1788387450614 | createdAt=2026-09-02T22:18:32.785Z | reason=acceptance-resume-probe create2 | relationships=Business Profile products
- product | cmtknqsys0003ie0a8oed5b9n | Agent Desk QA Product 1788387450614 | createdAt=2026-09-02T22:18:23.141Z | reason=acceptance-resume-probe create1 | relationships=Business Profile products

## Companies
- company | cmtko3cge0001jg0ax18dblql | Northstar Ops Ltd 1788388042953 | createdAt=2026-09-02T22:28:08.271Z | reason=run-acceptance-phases-3-42 | relationships=deal Northstar FDE Pilot
- company | cmtknqgqm0001ki0aylkrltwr | E2E-tenant-probe-1788387485726 | createdAt=2026-09-02T22:18:07.294Z | reason=hosted-production-acceptance tenant probe | relationships=none known
- company | cmtkie0850005ji049djdqho1 | E2E-tenant-probe-1788378506561 | createdAt=2026-09-02T19:48:27.942Z | reason=E2E-tenant-probe pattern | relationships=none known
- company | cmtgefvui0001kz045jri1ovo | E2E-tenant-probe-1788130011372 | createdAt=2026-08-30T22:46:52.410Z | reason=E2E-tenant-probe pattern | relationships=none known
- company | cmtkjgd500017l304x44y1sys | Alison Calder - | createdAt=2026-09-02T20:18:17.604Z | reason=weak-validation SUSPECT — confirm before cleanup | relationships=possibly contact-derived

## Deals
- deal | cmtko3e1s0001gt0a79y361hu | Northstar FDE Pilot 1788388042953 | createdAt=2026-09-02T22:28:10.336Z | reason=run-acceptance-phases-3-42 | relationships=company Northstar Ops Ltd

## Content
- content | cmtkey66h0001jk0ak5mjwlx1 | QA Smoke Test Post - Agent Desk Production Acceptance | createdAt=2026-09-02T18:12:10.313Z | reason=production-acceptance-probe2 Phase 9 | relationships=Content OS draft/publish smoke

## Orgs created by acceptance (not Shobhit Agency records, but QA residue)
- organisation | cmtko2ihw0002lb04ie3frui6 | Agent Desk New Business QA 1788388042953 | createdAt=2026-09-02T22:27:29.445Z | reason=Platform Admin create_beta (NOT Automated QA) | relationships=beta workspace residue

## CLEANUP CANDIDATES (for Shobhit approval — DO NOT DELETE YET)
1. Timestamped Batch / Aura Terminal QA / Agent Desk QA Product rows under Products.
2. E2E-tenant-probe-* companies.
3. Northstar Ops Ltd + Northstar FDE Pilot deal.
4. QA Smoke Test Post content piece.
5. Agent Desk New Business QA org — confirm not in use.
6. SUSPECT: Alison Calder - company — human confirm before cleanup.

## SOCIAL QUOTA NOTE (Agency — inventory only, no mutation)
- REQUIRED_MAX_FOR_IG_LI_YT_TT=4
- If CURRENT_SOCIAL_MAX=2 with IG+LI connected, YT+TT connect blocked until Platform Admin raises maxConnectedSocialAccounts. Do NOT silently raise.

NEXT_REQUIRED_HUMAN_ACTION=
1. Confirm Automated QA org credentials + E2E_TARGET_ORG_* fail-closed.
2. Approve or reject CLEANUP CANDIDATES.
3. If Agency needs IG+LI+YT+TT, Platform Admin sets social quota ≥ 4.
4. Resume mutating acceptance / Claude live retest only after that.
