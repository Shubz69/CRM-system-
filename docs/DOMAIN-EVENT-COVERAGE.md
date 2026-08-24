/**
 * Phase 12B follow-through — DomainEvent emission coverage matrix.
 *
 * Maturity reminder (do not upgrade):
 * - Outbox remains WORKING (not LIVE_E2E / not PRODUCTION_VERIFIED)
 * - Playwright skipped until E2E_EMAIL / E2E_PASSWORD exist
 * - Multi-worker production soak has not occurred
 * - Emission coverage below is incomplete by design for Phase 13 start
 */

| Mutation / behaviour | Catalogue type | Emits via outbox today? | Notes |
|---|---|---|---|
| Contact create | CONTACT_CREATED | **No** | inbound-pipeline / contacts API |
| Contact update | — | **No** | not in catalogue |
| Lead create | LEAD_CREATED | **No** | inbound uses sync automations |
| Lead qualification | LEAD_QUALIFIED | **No** | consumer ready; emitter missing |
| Lead stage change | LEAD_STAGE_CHANGED | **No** | |
| Company create | COMPANY_CREATED | **No** | crm-v2 upsertCompany |
| Company update | — | **No** | |
| Deal create | DEAL_CREATED | **Yes** | `crm-v2.createDeal` |
| Deal stage change | DEAL_STAGE_CHANGED | **Yes** (Phase 14) | PATCH `/api/deals` when stageLabel changes |
| Deal won | DEAL_WON | **Yes** (Phase 14) | PATCH `/api/deals` |
| Deal lost | DEAL_LOST | **Yes** (Phase 14) | PATCH `/api/deals` |
| Message received | MESSAGE_RECEIVED | **No** | sync automations |
| Conversation opt-out | CONVERSATION_OPTED_OUT | **No** | |
| Booking / meeting | MEETING_BOOKED | **No** | |
| Content approval | CONTENT_APPROVED | **Partial** | publishing approve path |
| Content publish requested | CONTENT_PUBLISH_REQUESTED | **Yes** (Phase 15) | `requestPublish` |
| Content published / failed / reconcile | CONTENT_PUBLISHED / FAILED / RECONCILIATION_REQUIRED | **Yes** (Phase 15) | only after provider ack / honest failure |
| Quality assessment completed | QUALITY_ASSESSMENT_COMPLETED | **Yes** (Phase 14F) | `verifyBusinessOpportunity` |
| Intelligence prediction recorded | INTELLIGENCE_PREDICTION_RECORDED | **Catalogue ready** | emit when Prediction Lab create path wires |
| Mission lifecycle | MISSION_* | **Yes** | create + mapped status transitions |
| Recommendation feedback | RECOMMENDATION_ACCEPTED/REJECTED | **No** | learning-os |
| Experiment lifecycle | — | **No** | not in catalogue |
| Goal create/activate/achieve | GOAL_* | **Yes** (Phase 13) | goals service |
| KPI snapshot | KPI_SNAPSHOT_RECORDED | **Yes** (Phase 13) | |
| Initiative started | INITIATIVE_STARTED | **Yes** (Phase 13) | when status ACTIVE |
| Opportunity detect/accept/reject/expire/complete | OPPORTUNITY_* | **Yes** (Phase 13) | |
| Sync completed/failed | SYNC_* | **Yes** (Phase 14) | connector sync engine |
| Integration connected/degraded/… | INTEGRATION_* | **Catalogue ready** | emit when connection lifecycle hooks wired |
Do not delay Phase 13 solely for incomplete CRM/messaging emit coverage.
Backfill emitters incrementally; keep dual-path automations until migrated.
