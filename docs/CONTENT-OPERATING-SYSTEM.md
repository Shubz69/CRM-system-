# Content Operating System

**Status:** Phase 6 — pipeline models + API + Ask “Turn this into content” → opportunity.

## Lifecycle

Research → **Opportunity** → Idea → Brief → Piece (+ Version/Variant) → Approval → PublishingJob → Measure (`PostPerformance`).

Every opportunity/idea/brief/piece must carry **whyEvidence** (rationale + researchJobId / trendClusterId / agentRunId / sourceUrls).

## Publishing

- `requestPublish` evaluates Kernel `social.publish` policy (default: **require approval**).
- Jobs start as `PENDING_APPROVAL` or `APPROVED` — never invent a live post.
- `recordPublishResult` requires a real `externalPostId` or `externalUrl` from the platform API.

## API

```http
GET  /api/content
POST /api/content  # actions: create_opportunity_from_research | create_idea | create_brief_and_piece | submit_approval | decide_approval | request_publish
```

Permission: `ask:use`.
