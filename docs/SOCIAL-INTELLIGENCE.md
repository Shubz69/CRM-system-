# Social Intelligence

**Status:** Phase 4 started. Models + ingest from research/social-listening.

## Canonical model

| Model | Role |
|-------|------|
| `SocialCreator` | Org+platform+handle identity |
| `SocialContent` | One row per org+platform+url (canonical post/video) |
| `SocialMetricSnapshot` | Append-only engagement time series |

Legacy `SocialPost` / `TrendSignal` remain for listening job extracts; ingest also writes canonical `SocialContent`.

## Ingestion

`ingestResearchJobSocialContent` runs after research / social-listening complete (best-effort; never fails the Ask run).

Metrics: each sighting with engagement inserts a **new** `SocialMetricSnapshot` — totals are never overwritten in place.

## Relationships

creator → content → format/topics; content links optional `researchSourceId` / `socialPostId`.

Postgres only for now; pgvector later for topic clustering if needed.
