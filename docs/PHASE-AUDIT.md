# Phase audit — DM Intelligence CRM

Evidence-based status after the full technical audit and remediation pass.

| Requirement | Previous | Work completed | Current | Tests | Key files |
|---|---|---|---|---|---|
| Auth + sessions | Working | Middleware added | Verified complete | Unit permissions | `src/lib/auth.ts`, `src/middleware.ts` |
| Org isolation | Incomplete | Webhook org fallback hardened; identifier uniqueness scoped | Working but incomplete* | Integration isolation | `inbound-pipeline.ts`, webhooks |
| Inbound pipeline | Working | Opt-out, attribution, notifications, automations wired | Verified complete | Integration + unit | `src/services/inbound-pipeline.ts` |
| Opt-out | Broken | Persist + cancel follow-ups + keyword detection | Verified complete | `tests/opt-out.test.ts` | `src/services/opt-out.ts` |
| Messaging adapters | Incomplete | Live when token present; mock default | Working but incomplete | Adapter unit | `src/adapters/messaging` |
| AI providers | Working | Mock/OpenAI/Anthropic + Zod repair | Verified complete | AI unit | `src/adapters/ai` |
| Knowledge | Incomplete | CRUD + PDF text extract + deactivate | Working but incomplete | Manual | `api/knowledge`, `services/knowledge` |
| Lead scoring | Working | Deterministic components | Verified complete | Scoring unit | `services/scoring.ts` |
| Inbox | Working | Assign, notes, pause/resume | Verified complete | E2E smoke | `inbox-client.tsx` |
| Dashboard filters | Missing UI | Date from/to wired | Verified complete | Manual | `dashboard/page.tsx` |
| Contacts detail | Missing | Detail page + export CSV + opt-out | Verified complete | Manual | `contacts/[id]` |
| Qualification builder | Missing | Fields CRUD UI + API + answer sync | Verified complete | Manual | `qualification` |
| Automations engine | Placeholder | Executor + CRUD + loop guard | Verified complete | `tests/automations.test.ts` | `services/automations.ts` |
| Follow-ups | Working | Worker + cancel on reply/opt-out/booking | Verified complete | Integration | `workers/followups.ts` |
| Notifications | Missing | In-app create/list/read | Verified complete | Manual | `services/notifications.ts` |
| Booking | Incomplete | Provider interface + webhook + notify | Working but incomplete | Manual | `adapters/booking` |
| Insights | Incomplete | Aggregation service + content/ads APIs | Working but incomplete | Manual | `insights-aggregation.ts` |
| Reports | Incomplete | POST generate + CSV; Sheets adapter stub | Working but incomplete | Manual | `api/reports` |
| Campaign attribution | Missing | Upsert on ingest | Verified complete | Integration logs | `services/attribution.ts` |
| Playwright journeys | Thin | Smoke exists; expanded journeys pending CI run | Working but incomplete | `e2e/smoke.spec.ts` | e2e |

\* Multi-org JWT switcher still single-membership; production webhooks must send `organisationId` or mapped `channel_id`.

## External-only remaining

- Live OpenAI/Anthropic API keys
- Live ManyChat token + webhook configuration
- Production Redis
- Live booking provider credentials
- Google Sheets / email delivery credentials
