# FRONTEND_ACCEPTANCE_REPORT

**Date:** 2026-08-27  
**Environment:** Authenticated local Next.js (`localhost:3000`) against embedded Postgres QA workspace `Shobhit Agency QA`  
**Operator:** Cursor agent visual + Playwright screenshot tour  
**IA:** Unchanged (CORE / SETUP / ADMIN)

## Method

1. UX polish for Business Profile, Content workspace, Knowledge freshness, Ask next actions, Creative Genome (Learning), CRM 360 progressive disclosure, Settings categories, Inbox responsive sheets.
2. Authenticated browser login (platform admin).
3. Playwright tour at 1440 desktop + 1024 tablet Inbox + 390 mobile Home/Inbox/CRM.
4. Screenshots saved under `QA/screenshots/`.
5. Quality gate: `npm run typecheck`, `npm run lint`, `npm test`.

## Visual ratings (desktop)

| Page | Rating | Notes / fixes |
|------|--------|---------------|
| Home (`/home` → Ask hub) | GOOD | Clear Ask composition; empty-friendly cards |
| Ask | GOOD | Next-action labels wired to real APIs |
| Inbox | GOOD | 3-col desktop; list↔thread mobile; customer sheet tablet/mobile |
| CRM | GOOD | Hub + empty CRM states intact |
| Pipeline | GOOD | Usable empty board |
| Contacts | GOOD | List + detail progressive disclosure |
| Companies | GOOD | Empty/onboarding safe |
| Deals | GOOD | Empty/onboarding safe |
| Growth | GOOD | Hub intact |
| Opportunities | GOOD | Empty state deliberate |
| Research | GOOD | Empty state deliberate |
| Social Intelligence | GOOD | Empty state deliberate |
| Content | GOOD | Status buckets + customer labels |
| Goals | GOOD | Empty state deliberate |
| Business Profile | EXCELLENT | Confirmed / Needs review / Missing hierarchy |
| Knowledge | GOOD | Freshness chips + Review/Replace/Upload/Research actions |
| Automations | GOOD | Empty/onboarding safe |
| Analytics | GOOD | Empty/onboarding safe |
| Integrations | GOOD | Connection cards clear |
| Settings | GOOD | Workspace → Advanced categories; eng flags not shown |
| Admin | GOOD | Visible only for platform admin |
| Learning / Creative Genome | GOOD | Patterns only above sample thresholds |
| Command palette | GOOD | Focus trap + Escape; search groups |

## Mobile / tablet

| Surface | Rating | Notes |
|---------|--------|-------|
| Mobile Home | GOOD | Single column; Menu drawer |
| Mobile Inbox | GOOD | Conversation list only (not 3-col squeeze) |
| Mobile CRM | GOOD | Usable single column |
| Tablet Inbox | GOOD | List + thread; customer intel via sheet |

## Accessibility

- Command palette: dialog + focus trap + Escape restore focus.
- Inbox customer sheet: `role="dialog"`, Escape closes.
- Status chips use labels, not colour alone (Confirmed / Missing / etc.).

## Roles

- Platform admin sees Admin nav.
- Normal members do not get Admin entry (existing nav gating unchanged).
- Admin pages remain permission-gated server-side.

## Playwright E2E product journeys

**SKIPPED WITH REASON — credentials unavailable** for hosted `E2E_EMAIL` / `E2E_PASSWORD`.  
Local visual acceptance Playwright screenshot tour **passed** (`e2e/qa-visual-acceptance.spec.ts`).

## Tests

```
typecheck: PASS
lint: PASS (0 errors, warnings only)
test: 446 passed, 1 skipped, 0 failed
```

## Remaining issues (non-blocking)

1. Hosted Vercel login password unknown in this environment (Supabase auth from local `.env` also failed) — acceptance ran on local authenticated stack with the polished UI.
2. Embedded Postgres QA DB lacks pgvector; knowledge embeddings unavailable locally (UI still works).
3. Growth subnav dense on narrow widths (horizontal scroll/tab wrap) — usable, not FAIL.

## Final verdict

**ACCEPTED** — authenticated visual QA completed; UX closure items closed without IA redesign; quality gate green.
