# Architecture

## High-level flow

```text
ManyChat / Simulator
        │
        ▼
Webhook / API route (secret + Zod validation)
        │
        ▼
WebhookEvent (idempotency key)
        │
        ▼
Inbound pipeline service (transactional upserts)
  - Contact + ContactIdentifier
  - Conversation + Message
  - Lead + PipelineStage
        │
        ▼
Knowledge retrieval (lexical chunk ranking)
        │
        ▼
AI provider adapter (mock | openai | anthropic)
  - structured JSON
  - Zod validate
  - one repair retry
        │
        ▼
Lead scoring (config-driven, not AI-silent)
        │
        ├── Objections / Questions / Buying signals
        ├── Follow-up scheduling (BullMQ / in-process)
        └── Messaging adapter send (mock ManyChat)
                │
                ▼
        Inbox / Dashboard / Insights
```

## Tenancy

Every business record is scoped by `organisationId`. API handlers load the session membership and query with that org id. Cross-org access is rejected by construction.

## Layers

- `src/app` — UI + route handlers
- `src/services` — business workflows
- `src/adapters` — AI / messaging / booking ports
- `src/schemas` — shared Zod contracts
- `src/workers` — background jobs
- `prisma` — schema + seed

## Security notes

- Credentials encrypted at rest via AES-256-GCM (`ENCRYPTION_KEY`)
- Webhook secrets compared with timing-safe equality
- Secrets never logged
- Lead messages treated as untrusted prompt input
- Opt-out cancels follow-ups and skips AI replies
