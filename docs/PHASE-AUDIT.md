# Phase audit — DM Intelligence CRM

Evidence-based status after the remaining-gaps completion pass.

| Requirement | Previous | Work completed | Current | Tests | Key files |
|---|---|---|---|---|---|
| Auth + sessions | Working | Middleware + multi-org JWT switch | Verified complete | Unit permissions | `src/lib/auth.ts`, `src/middleware.ts` |
| Org isolation | Incomplete | Memberships on JWT; org switch API/UI; channel ambiguity guard; booking no first-org fallback | Verified complete | Integration isolation + e2e switcher | `auth.ts`, webhooks, `app-shell.tsx` |
| Inbound pipeline | Working | Opt-out, attribution, notifications, automations, channelExternalId | Verified complete | Integration + unit | `src/services/inbound-pipeline.ts` |
| Opt-out | Working | Persist + cancel follow-ups + keyword detection | Verified complete | `tests/opt-out.test.ts` + e2e | `src/services/opt-out.ts` |
| Messaging adapters | Incomplete | Live when token present; mock default; channel mapping Settings UI | Verified complete | Adapter unit | `src/adapters/messaging`, `api/messaging-channels` |
| AI providers | Working | Mock/OpenAI/Anthropic + Zod repair | Verified complete | AI unit | `src/adapters/ai` |
| Knowledge | Incomplete | CRUD + PDF extract + archive + id-based update + rechunk | Verified complete | `tests/adapters-extended.test.ts` + e2e | `api/knowledge`, `services/knowledge` |
| Lead scoring | Working | Deterministic components | Verified complete | Scoring unit | `services/scoring.ts` |
| Inbox | Working | Assign, notes, pause/resume | Verified complete | E2E smoke | `inbox-client.tsx` |
| Dashboard filters | Working | Date from/to wired | Verified complete | Manual | `dashboard/page.tsx` |
| Contacts detail | Working | Detail page + export CSV + opt-out | Verified complete | Manual | `contacts/[id]` |
| Qualification builder | Working | Fields CRUD UI + API + answer sync | Verified complete | Manual | `qualification` |
| Automations engine | Working | Executor + CRUD + booking adapter | Verified complete | `tests/automations.test.ts` | `services/automations.ts` |
| Follow-ups | Working | Worker + cancel on reply/opt-out/booking | Verified complete | Integration | `workers/followups.ts` |
| Notifications | Working | In-app create/list/read + booking notify | Verified complete | Manual | `services/notifications.ts` |
| Booking | Incomplete | Provider wired end-to-end; parseWebhook `event`; mock log; org required | Verified complete | Adapter unit | `adapters/booking`, booking webhook |
| Insights | Incomplete | UI shape fix; aggregate API; worker sweep | Verified complete | Manual + e2e | `insights-*`, worker |
| Reports | Incomplete | POST generate + CSV; Sheets/email adapters + export API | Verified complete | Adapter unit + e2e | `api/reports`, `adapters/sheets`, `adapters/email` |
| Campaign attribution | Working | Upsert on ingest | Verified complete | Integration logs | `services/attribution.ts` |
| Playwright journeys | Thin | Opt-out, knowledge, reports, insights, org switch + smoke | Verified complete | `e2e/smoke.spec.ts` | e2e |
| Health / prod guards | Missing | `/api/health`; demo login gate; prod secret checks; booking rate limit | Verified complete | Manual | `api/health`, `lib/env.ts` |

## External-only remaining

These require customer credentials / infrastructure and are intentionally credential-gated:

- Live OpenAI/Anthropic API keys
- Live ManyChat token + webhook configuration from Instagram
- Production Redis / managed Postgres backups / HTTPS edge
- Live booking provider account webhooks
- Official Google Sheets (`googleapis`) and SMTP (`nodemailer`) transport wiring once secrets exist
