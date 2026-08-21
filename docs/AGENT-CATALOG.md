# Agent Catalogue (Target)

Specialised agents for Agent Desk. **Built-in today** vs **planned**.

Users should not need to know these names; the supervisor routes by outcome. Advanced users may pin custom agents later (no-code builder — Phase 10).

---

## Built-in today (code)

| Agent | File | Role |
|-------|------|------|
| `echo` | `echo.ts` | Framework smoke test |
| `summarise` | `summarise.ts` | Short text summary |
| `research` | `research.ts` | Multi-source research job |
| `social_listening` | `social-listening.ts` | High-engagement social scan |
| `analyst` | `analyst.ts` | Social pack: short answer, brief, viral, forecasts narrative |
| `critic` | `critic.ts` | Citation URL verification |
| `imaging_analyze` | `imaging-analyze.ts` | Vision → prompt (confirm) |
| `imaging_generate` | `imaging-generate.ts` | Image generation |

Supervisor: deterministic pipelines in `supervisor/plan.ts` (+ unused LLM planner).

---

## Planned catalogue

| Agent | Objective | Tools (examples) | Approval default |
|-------|-----------|------------------|------------------|
| Executive Strategy | Prioritised weekly focus from goals/KPIs/pipeline | CRM read, analytics read, knowledge | Auto draft |
| Deep Research | Multi-query parallel investigation | Source registry | Auto |
| Competitor Intelligence | Track competitors & gaps | Web, social search | Auto |
| Social Listening | Audience needs, sentiment, language | Social sources | Auto |
| Trend Intelligence | Accelerating topics/formats | Social metrics, clustering | Auto |
| Trend Forecasting | Probabilistic forecasts | Feature pipeline | Auto (label uncertainty) |
| Platform Algorithm Intelligence | Maintain AlgorithmChange evidence | Official docs + observation | Auto |
| Audience Intelligence | Segments from CRM + social | CRM, social | Auto |
| Content Strategist | Strategy from goals + research | Knowledge, research artifacts | Auto |
| Creative Director | Concepts, angles, formats | — | Auto |
| Script & Copy | Platform-native copy | Knowledge (tone) | Auto drafts |
| SEO & Search Intelligence | Demand & gaps | Web/search providers | Auto |
| Distribution | Channel/timing/repurpose | Analytics | Auto |
| Publishing | Schedule/publish | Social OAuth tools | **Approve** |
| Community | Comments/replies | Social reply APIs | **Approve** outbound |
| Lead Qualification | Fit & buying signals | Inbox, CRM, knowledge | Per Autopilot |
| Sales | Progression, objections, booking | CRM, booking, messaging | Per Autopilot |
| CRM Intelligence | Clean/enrich/rescue | CRM write | Configurable |
| Nurture | Multi-step follow-ups | Messaging, CRM | **Approve** default |
| Revenue Intelligence | Campaign → revenue | Attribution, CRM | Auto |
| Experiment | Design/measure tests | Analytics | Auto |
| Performance Analyst | What worked/why | Metrics | Auto |
| Brand Guardian | Tone/compliance/claims | Knowledge | Gate on publish |
| Knowledge Architect | Structure reusable knowledge | Knowledge write | **Approve** publish |
| Onboarding | Configure workspace from company intake | Research, knowledge | Guided |
| Executive Reporting | Daily/weekly briefs | All read scopes | Auto |

Custom agents compile into Kernel definitions — **no arbitrary code execution**.

---

## Containment

Research ≠ publish ≠ billing ≠ user admin. Credentials and tools scoped narrowly; every consequential action audited.
