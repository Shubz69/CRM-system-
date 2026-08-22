# Integration Capability Matrix

**Status:** Phase 3 — live API.

## Endpoint

```http
GET /api/integrations/capability-matrix
Permission: integrations:manage
```

Returns platform × capability status from **real** env/adapter configuration:

| Status | Meaning |
|--------|---------|
| `configured` | Credentials present / adapter usable |
| `requires_credentials` | Supported but not configured |
| `unsupported` | Not implemented for this platform |
| `degraded` | Reserved for partial outages |

Capabilities: `search_public`, `read_owned_content`, `publish`, `schedule`, `analytics`, `webhooks`.

Social OAuth publish rows are connection-specific (see Settings → Social); the matrix marks them as requiring a per-org connection rather than inventing “connected”.

See also `docs/INTEGRATIONS.md`, `docs/SOCIAL_CONNECTIONS.md`, `docs/RESEARCH-INTELLIGENCE.md`.
