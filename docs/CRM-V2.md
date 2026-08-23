# CRM V2

**Status:** Phase 7 — Company / Deal / Activity / Customer 360 / templates + UI surfaces.

## Additions

- **Company** (Account) — contacts optional `companyId`
- **Deal** — coexists with **Lead** via optional `leadId`
- **CrmActivity** — task / meeting / call / email timeline
- **Attribution** — `confidence`, `limitations`, `method` (honest defaults)
- **Industry templates** — config on Organisation (`industryTemplateKey` + snapshot), not product forks

## UI

| Page | Purpose |
|------|---------|
| `/companies` | List + create companies |
| `/deals` | List + create + status PATCH |
| `/contacts/[id]` | **Customer 360** panel (company, deals, attribution confidence, activities) |
| `/pipeline` | Lead kanban (links to Deals) |

## APIs

| Endpoint | Permission |
|----------|------------|
| `GET\|POST /api/companies` | leads:read / leads:write |
| `GET\|POST\|PATCH /api/deals` | leads:read / leads:write |
| `GET /api/contacts/[id]/360` | leads:read |
| `GET\|POST /api/crm/templates` | leads:read / integrations:manage |

## Customer 360

Evidence from stored CRM rows only. Response includes explicit `limitations[]`. No sensitive inference. Attribution confidence shown as **unknown** when null.

## Templates

`generic` · `agency` · `b2b_saas` · `creator` · `coaching` — pipeline stage hints + qualification hints. Do not force Instagram-setter workflows.
