# Social Intelligence

**Status:** Spec (Phase 4). Foundation: SocialPost, TrendSignal, Apify adapters, SocialConnection.

## Canonical model (target)

SocialProfile, SocialContent, SocialMetricSnapshot (time series), SocialComment, Topic, Creator, AudienceCluster, Format, TrendCluster…

Keep platform raw metadata. Compute velocity/acceleration from snapshots — never overwrite-only totals.

## Relationships

creator→content→topic/format; campaign→content; content→lead when attributable.

Use Postgres + pgvector; no separate graph DB unless proven necessary.
