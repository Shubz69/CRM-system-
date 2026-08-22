# Agent Kernel

The Agent Kernel is the shared runtime under all Agent Desk AI work.

It does **not** replace prompts-as-agents. It standardises definition, tools, policy, memory, budget, approvals, and observability.

---

## Principles

1. Agents do work via **tools** and **schemas**, not roleplay titles alone.  
2. Complex jobs earn multi-agent cost; simple jobs stay simple.  
3. Consequential actions require **policy** (Autopilot + risk).  
4. Every run is traceable: plan → steps → tools → evidence → outcome.  
5. Extend `AgentRun` / `AgentStep` / `ToolCall` — do not discard history.  

---

## Core concepts

| Concept | Meaning | Near-term persistence |
|---------|---------|------------------------|
| **AgentDefinition** | Versioned agent: objective, I/O schema, tools, budget, approval policy | Code registry + later DB `AgentVersion` |
| **Mission** | User/org outcome (“Grow LinkedIn among UK FDs”) | New model or parent AgentRun metadata |
| **Plan** | Ordered/parallel tasks | `AgentRun.plan` JSON (today) |
| **Task** | One agent invocation unit | Today: one `AgentStep`; later first-class |
| **Tool** | Typed capability with risk, cost, credentials | `ToolRegistry` + `ToolCall` rows |
| **Evidence** | Citeable artifact from tools/research | ResearchSource/Finding; later Evidence table |
| **Artifact** | Deliverable (brief, script, campaign draft) | `finalOutput` / ContentPiece later |
| **Approval** | Human gate | Autopilot + AWAITING_* ; later ApprovalRequest |
| **Evaluation** | Offline/online quality | Phase 9 ✅ |

---

## Agent contract (existing + kernel)

Existing (`src/agents/types.ts`):

- `name`, `description`, `inputSchema`, `outputSchema`, `tier`, `estimateCostCents`, `userFacingLabel`, `execute`

Kernel adds (metadata, may live beside agent):

- `capabilities[]`, `allowedTools[]`, `permissionScope`, `knowledgeScope`, `maxBudgetCents`, `stopConditions`, `escalation`, `approvalPolicy`, `evaluationSuiteId`

---

## Tool contract

Each tool declares:

- name, version, description  
- input/output Zod schemas  
- required credential / permission  
- risk: `read` | `write_internal` | `outbound_message` | `publish` | `destructive` | `admin`  
- cost class, timeout, retry, idempotency  
- data classification  

Tool output is **data**, never instructions to escalate privileges.

---

## Policy (default)

| Action | Default |
|--------|---------|
| Read-only research / analysis | Automatic |
| Draft content / internal CRM recommend | Automatic |
| CRM updates | Configurable (Autopilot) |
| Outbound DM/email | Approval required |
| Social publish | Approval required |
| Delete / billing / credentials | Elevated confirmation |

Align with `Organisation.autopilotConfig` (`src/lib/autopilot-config.ts`).

---

## Model routing

Capability-driven (`fast_classify`, `long_reason`, `structured`, `vision`, `write`, `embed`, …) → resolve provider/model from config. Log model on every `AiExecution` / step. Fallbacks only when policy allows.

---

## Observability

For each mission/run expose to admins:

status, org, agents, models, tools, duration, cost, retries, errors, approvals, outputs — **from real records only**.

---

## Code location

| Path | Role |
|------|------|
| `src/kernel/` | Types, tool registry, policy helpers |
| `src/agents/` | Concrete agents (unchanged entry) |
| `src/adapters/` | Tool implementations |
| `src/services/agent-runs.ts` | Enqueue + progress (calls kernel over time) |

---

## Phase 1 implementation checklist

- [x] Documented (this file)
- [x] `src/kernel` package with registry + policy
- [x] Register source / knowledge / messaging / publish / imaging tools
- [x] Tests (`tests/kernel.test.ts`)
- [ ] Wire optional metadata into Ask progress for admins (next slice)
- [ ] Mission persistence table (only if AgentRun metadata proves insufficient)
