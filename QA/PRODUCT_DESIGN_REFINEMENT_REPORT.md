# AGENT DESK PRODUCT DESIGN REFINEMENT REPORT

Date: 2026-08-27  
Scope: Product design / UX refinement only (no backend redesign, no IA change, no new feature phase).

## P0 Fixes

1. **Active subnav** — Replaced dark `sidebar`/white-text pills with teal soft fill + inset underline; `aria-current` / `data-active`; keyboard focus via `focus-ring`. Mobile uses a labelled `<select>` switcher (`md:hidden`); desktop keeps full tabs.
2. **Customer-facing internals** — Automations use human trigger/action labels; raw enums only in Advanced. Analytics → Learning rebuilt for business insights only. Eng eval/Brier/candidates/prompt controls moved to **Admin → Learning Lab**.
3. **Misleading metrics** — CRM hub no longer shows stage count as “Open pipeline”; labels are **Open pipeline value** or **Pipeline stages**.

## Navigation / Tabs

- Responsive section switcher for CRM / Growth / Analytics / Admin.
- Regression tests assert readable active styles and switcher presence.

## Header

- Menu remains `lg:hidden` (sidebar visible on desktop).
- Full “Search Agent Desk” field on `sm+`; icon-only search only on narrow mobile.
- Notifications unchanged.

## Home

- Hierarchy: greeting → attention → recommended next moves (WHAT + Why) → honest business snapshot.
- Snapshot uses live counts (conversations needing reply, contacts, open deals, opportunities, goal progress) — no “Inbox / Open” or “Pipeline / CRM” placeholders.

## Inbox

- `conversationCount === 0`: centred onboarding (connect / test / setup) — no empty three-column desktop.
- With data: existing three-column / tablet / mobile panel behaviour retained.

## CRM

- Metrics corrected; empty workspace shows one cohesive CRM setup state, then module links.

## Growth

- Metrics + empty “Where can you grow?” setup path; module navigation retained.

## Analytics

- Outcome overview (Sales / Messaging / Growth) from real API counts, then directory links.
- Learning link copy clarifies business patterns (not eng evals).

## Content

- Workspace / buckets first; **+ Create** opens SlideOver composer. Rationale/source optional under Advanced.

## Knowledge

- Library + filters first; gaps below; **+ Add** opens write/upload/research options in SlideOver.

## Automations

- NL “Describe what should happen” primary; readable When/Then cards; Advanced field builder with labelled selects; WorkflowViewer shows When/Wait/Then (not raw kinds).

## Business Profile

- Completion % hero + accordion checklist (expand to edit) instead of ten large identical cards.

## Pipeline

- Desktop: horizontal kanban with scroll affordance.
- Mobile: stage switcher + compact list (not forced wide canvas).

## Settings

- Desktop: left Settings sub-nav; mobile: section `<select>` (no cramped 9-pill bar).

## Admin

- Metrics grouped: Platform / Messaging / AI / Sales / Reliability.
- Learning Lab added under Admin subnav.

## Mobile

- Subnav switcher; Menu only when needed; pipeline stage switcher; reduced nested cards on Home recommendations.

## Populated QA

- Not fully re-captured in this pass (hosted auth previously blocked; local embedded Postgres available on `:54329`).
- Recommend: login locally → simulator for Inbox → fixture CRM/Growth → screenshot set at 1440 / 1280 / 1024 / 768 / 390.

## Technical Language Audit

| Surface | Status |
|--------|--------|
| Automations customer UI | Human labels; enums Advanced-only |
| Analytics → Learning | Business modules only |
| Admin → Learning Lab | Eng controls retained |
| CRM metrics | Configuration vs commercial distinguished |
| Workflow viewer | When/Wait/Then labels |

## Visual Ratings

| Surface | Rating | Notes |
|---------|--------|-------|
| Home | GOOD → EXCELLENT pending populated screenshot | Structure meets CoS hierarchy |
| Inbox | GOOD → EXCELLENT pending populated | Empty mode fixed |
| CRM | GOOD | Metrics + empty cohesion |
| Growth | GOOD | Empty path + metrics |
| Command palette | GOOD | Unchanged intentionally |
| Content / Knowledge / Automations / Profile | GOOD | Form-first reversed |
| Analytics | GOOD | Outcome overview added |
| Settings / Admin | GOOD | Nav + grouping |

**Strict:** Without a fresh authenticated screenshot set, flagship surfaces are not yet declared EXCELLENT from visual evidence alone.

## Tests

- `npm run typecheck` — pass
- `npm run lint` — 0 errors (existing warnings only)
- `npm test` (local Postgres `DATABASE_URL` → `:54329`) — **456 passed, 0 failed**
- Added: `tests/product-design-refinement.test.ts`, automation labels in `customer-labels.test.ts`, Learning Lab nav assertion, fixed `ai-spend-gate` DB isolation into `ai-spend-gate.db.test.ts`

## Remaining Issues

1. Fresh **BEFORE/AFTER + populated** screenshot QA still required for ACCEPTED visual gate.
2. Floating **N** mitigated via `devIndicators: false` in `next.config.ts` (dev tooling, not product UI).
3. Integrations loading now uses card skeletons; loaded state still needs explicit visual QA.
4. Some pages still use similar white surfaces — tokens (`surface-primary`, `surface-insight`, `surface-attention`, `surface-muted`) are available; further adoption can continue incrementally.
5. Run tests with reachable Postgres; remote unreachable `DATABASE_URL` yields failed suites rather than skips.

## Final Verdict

**NOT ACCEPTED** for flagship visual ship criteria.

P0 product defects from the screenshot review are addressed in code; test baseline is green on local Postgres. Declare **ACCEPTED** only after authenticated rendered QA confirms EXCELLENT Home/Inbox/CRM/Growth and no normal-user NEEDS_FIX at the listed breakpoints — including populated fixtures.
