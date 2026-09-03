# ASK / RESEARCH LIVE FAILURE CLOSURE

**Date:** 2026-09-03  
**Base production SHA (still live):** `d012df295669e6b25f0a07edf374e25b67bcffcd`  
**Local fix tree:** uncommitted on `main` (not pushed / not deployed)  
**Tenant used for analysis:** Agent Desk Automated QA (`cmtkp47vk0000l504gvfzi1sj`) — no Shobhit Agency writes for this work.

```
ROOT_CAUSE=Ask first agent step threw after billable source/AI work (most often research findings extract or analyst brief completeStructured Zod failure; social_listening threw on missing sources). AgentRun.totalCostCents stayed 0 so UI said "No AI charge…" while org AiExecution spend rose. Optional source failures could fail the whole run instead of degrading. Ask template cards only prefilled (looked dead). Research with Ask was disabled with empty topic (zero network).

ASK_CONTEXT_ONLY=FIXED_LOCALLY (summarise degrades; live COMPLETED requires deploy)
ASK_CRM=FIXED_LOCALLY (shared supervisor path; live retest after deploy)
ASK_KNOWLEDGE=FIXED_LOCALLY (privacy/model remap already local; live retest after deploy)
ASK_WEB_RESEARCH=FIXED_LOCALLY (research extract no longer throws after sources)
ASK_MULTI_SOURCE=FIXED_LOCALLY (per-platform degrade retained; findings/analyst harden)

QUICK=FIXED_LOCALLY
EXECUTIVE=FIXED_LOCALLY
ACTION_PLAN=FIXED_LOCALLY
DEEP_REPORT=FIXED_LOCALLY

OPTIONAL_SOURCE_DEGRADATION=FIXED_LOCALLY
COST_UI_CORRECT=FIXED_LOCALLY
ASK_TEMPLATE_CARDS=FIXED_LOCALLY
RESEARCH_WITH_ASK=FIXED_LOCALLY

RETIRED_MODEL_REMOVED=FIXED_LOCALLY (resolveOperationalAnthropicModel remaps claude-sonnet-4-20250514)
CUSTOMER_PROVIDER_PRIVACY=FIXED_LOCALLY (toCustomerAiError + supervisor sanitization)

TYPECHECK=PASS
LINT=PASS (0 errors; pre-existing warnings only)
TESTS=PASS (723+; full vitest green after adapters mock isolation)
PLAYWRIGHT=ADDED (e2e/ask-research-ux.spec.ts — run on hosted after deploy)

NEW_SHA=NONE (uncommitted; ask to commit)

FINAL_VERDICT=NOT_READY

READY_TO_PUSH_FOR_LIVE_RETEST=NO (commit + push + deploy required first)
```

## Exact terminal failure

User string **"I couldn't finish that request…"** only when supervisor `execute.ts` catches a **first-step throw** with **zero completed step outputs**.

Primary path matching spend↑ + costNote "No AI charge" + 1–2.5 min:
1. Research fans out sources (Apify/Tavily bill into `AiExecution` → org spend)
2. `completeStructured(findingsExtractSchema)` **throws** on Zod failure
3. Step never returns `costCents` → `AgentRun.totalCostCents` stays 0 → costNote lies
4. Run FAILED with generic couldn't-finish copy

Secondary: analyst `briefSchema` throw after research → PARTIAL (different copy) or first-step if research was the only step that failed earlier. Social listening threw on `SourceNotConfiguredError` instead of degrading.

Older research job message **"couldn't reach any research sources"** = `ResearchJob` with zero ranked sources (credentials/adapters), distinct from Ask FAILED string. Prospecting Tavily OK ≠ Ask research healthy when Apify fan-out / extract throws.

## Fixes shipped locally

| Area | Change |
|------|--------|
| Research | `completeStructuredSafe` for findings; sources-only COMPLETED on extract fail; flexible URLs |
| Social listening | Catch unconfigured sources; per-post extract Safe degrade |
| Analyst | Safe + findings/sources fallback brief |
| Summarise | Safe + truncate fallback |
| Cost UI | RUNNING: "Usage updates after tool calls complete."; FAILED: monthly spend note — never "No AI charge" mid-run |
| Ask cards | Toast + focus/caret for prefills |
| Research CTA | Empty topic → toast; non-empty → POST `/api/ask` + router to Ask |
| Privacy | Stronger provider/model scrub; supervisor sanitizes leaked step errors |

## Tests

- `tests/ask-research-degradation.test.ts` (new)
- `e2e/ask-research-ux.spec.ts` (new)
- `tests/adapters-extended.test.ts` isolates mock email when SMTP env present

## Do not deploy automatically

Await commit + push approval, then Vercel/Railway deploy on new SHA, then live retest all four modes on Automated QA.
