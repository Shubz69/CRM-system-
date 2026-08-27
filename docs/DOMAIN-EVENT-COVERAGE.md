/**
 * Phase 12B follow-through — DomainEvent emission coverage matrix.
 *
 * Maturity reminder (do not invent LIVE_E2E / PRODUCTION_VERIFIED):
 * - Outbox remains WORKING
 * - Playwright skipped until E2E_EMAIL / E2E_PASSWORD exist
 * - Multi-worker production soak has not occurred
 */

| Mutation / behaviour | Catalogue type | Emits via outbox today? | Notes |
|---|---|---|---|
| Contact create | CONTACT_CREATED | **Yes** | inbound-pipeline create path |
| Contact update | CONTACT_UPDATED | **Yes** | inbound-pipeline when existing contact |
| Lead create | LEAD_CREATED | **Yes** | inbound-pipeline |
| Lead qualification | LEAD_QUALIFIED | **No** | consumer ready; emitter thin |
| Lead stage change | LEAD_STAGE_CHANGED | **No** | |
| Company create | COMPANY_CREATED | **Yes** | crm-v2 upsertCompany |
| Company update | COMPANY_UPDATED | **Yes** | crm-v2 upsertCompany |
| Deal create | DEAL_CREATED | **Yes** | crm-v2.createDeal |
| Deal stage change | DEAL_STAGE_CHANGED | **Yes** | PATCH `/api/deals` |
| Deal won / lost | DEAL_WON / DEAL_LOST | **Yes** | PATCH `/api/deals` |
| Message received | MESSAGE_RECEIVED | **Yes** | inbound-pipeline |
| Conversation create | CONVERSATION_CREATED | **Yes** | inbound-pipeline |
| Conversation opt-out | CONVERSATION_OPTED_OUT | **No** | |
| Booking / meeting | MEETING_BOOKED | **No** | |
| Content approval | CONTENT_APPROVED | **Partial** | publishing approve path |
| Content publish requested | CONTENT_PUBLISH_REQUESTED | **Yes** | `requestPublish` |
| Content published / failed / reconcile | CONTENT_PUBLISHED / FAILED / RECONCILIATION_REQUIRED | **Yes** | only after provider ack / honest failure |
| Quality assessment completed | QUALITY_ASSESSMENT_COMPLETED | **Yes** | intelligence-quality |
| Intelligence prediction recorded | INTELLIGENCE_PREDICTION_RECORDED | **Yes** | Prediction Lab create |
| Intelligence prediction evaluated | INTELLIGENCE_PREDICTION_EVALUATED | **Yes** | backtest score path |
| Evaluation completed | EVALUATION_COMPLETED | **Yes** | `runDeterministicEvalSuite({ organisationId })` |
| Learning update proposed / promoted | LEARNING_UPDATE_PROPOSED / PROMOTED | **Yes** | canary + controlled-learning |
| Mission lifecycle | MISSION_* | **Yes** | create + mapped status transitions |
| Recommendation feedback | RECOMMENDATION_ACCEPTED/REJECTED | **No** | learning-os |
| Goal create/activate/achieve | GOAL_* | **Yes** | goals service |
| KPI snapshot | KPI_SNAPSHOT_RECORDED | **Yes** | |
| Initiative started | INITIATIVE_STARTED | **Yes** | when status ACTIVE |
| Opportunity detect/accept/reject/expire/complete | OPPORTUNITY_* | **Yes** | |
| Sync completed/failed | SYNC_* | **Yes** | connector sync engine |
| Integration connected/degraded/… | INTEGRATION_* | **Catalogue ready** | emit when connection lifecycle hooks wired |
| Business state change | STATE_CHANGED | **Catalogue ready** | emit from state engine when transition occurs |
| Evidence debt raised/cleared | EVIDENCE_DEBT_* | **Catalogue ready** | evidence-debt service |
| Decision created/made/outcome | DECISION_* | **Catalogue ready** | decision-ledger |
| Process bottleneck / automation opportunity | PROCESS_BOTTLENECK_DETECTED / AUTOMATION_OPPORTUNITY_DETECTED | **Catalogue ready** | process-twin |
| Creative features / patterns | CREATIVE_* | **Catalogue ready** | creative-genome |
| Tool trust change | TOOL_TRUST_CHANGED | **Catalogue ready** | tool-trust |
| Counterfactual comparison | COUNTERFACTUAL_COMPARISON_COMPLETED | **Catalogue ready** | counterfactual lab |

Backfill remaining CRM/messaging emitters incrementally; keep dual-path automations until migrated.
Phase 20 events are catalogue-ready — wire emitters at call sites as services are adopted in production paths.
