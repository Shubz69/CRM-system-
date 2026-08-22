# Algorithm Intelligence

**Status:** Phase 5 — `AlgorithmChange` model + API.

## AlgorithmChange

Fields: platform, surface (Reels FYP, YT Shorts, LI Feed…), change type, detected/effective dates, `evidenceKind` (`OFFICIAL` | `OBSERVATIONAL` | `UNKNOWN`), confidence, affected formats, expected impact, recommended experiment, validation notes.

**Official requires a source URL** — otherwise the write path forces `UNKNOWN`.

Separate **official** documentation from **inferred** behaviour. When unknown, say unknown.

## API

```http
GET  /api/algorithm-changes   # insights:read
POST /api/algorithm-changes   # integrations:manage
```
