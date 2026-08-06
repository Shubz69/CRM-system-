# Knowledge & SOPs

## Managing documents

Administrators can create, upload (PDF/TXT/MD), categorise, activate/deactivate, and archive documents at `/knowledge`.

Documents are chunked for retrieval. Only relevant chunks are injected into the AI prompt.

## Knowledge gaps

When retrieval is empty or AI confidence is low, the inbound pipeline creates a `KnowledgeRecommendation`.

Recommendations appear under **Knowledge gaps** on `/knowledge`. Statuses:

- `NEW`
- `REVIEWED`
- `APPROVED`
- `DISMISSED`
- `USED`

Nothing is published automatically — an administrator must approve and add the content as a document.

## API

- `GET/POST/PATCH/DELETE /api/knowledge`
- `GET/PATCH /api/knowledge/recommendations`
