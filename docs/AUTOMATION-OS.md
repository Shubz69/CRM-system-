# Automation OS

**Status:** Phase 8 — NL → visible workflow + ApprovalRequest gates.

## Flow

Trigger → Conditions → Logic → Actions → **Approval** (outbound) → Outcome.

## NL compile

`POST /api/automations` with `{ action: "compile", naturalLanguage }` returns a **visible** workflow (steps) before enable.

`create_from_nl` saves the rule **inactive** until reviewed.

Deterministic keyword compile — only known triggers/actions; never invents capabilities.

## Approvals

Outbound actions (`send_follow_up`, `send_booking_link`, …) create `ApprovalRequest` when `requiresApproval` is true (default).

`GET|POST /api/approvals` — list / decide. Approval runs gated actions.

## Foundation

Still uses `AutomationRule` + `AutomationExecution` (+ workflow snapshot). Visual builder deferred until NL path is solid.
