/**
 * Automations only offer / accept triggers that are actually emitted and actions that have an
 * executor. Guards against drift with the emitters and the executeAction switch.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ruleCreate: vi.fn(),
  ruleUpdateMany: vi.fn(),
  ruleFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    automationRule: {
      create: (...args: unknown[]) => mocks.ruleCreate(...args),
      updateMany: (...args: unknown[]) => mocks.ruleUpdateMany(...args),
      findMany: (...args: unknown[]) => mocks.ruleFindMany(...args),
    },
  },
}));

vi.mock("@/kernel", () => ({
  ensureBuiltinToolsRegistered: vi.fn(),
  evaluateToolPolicy: vi.fn(() => ({ effect: "require_approval", reason: "ok" })),
}));

vi.mock("@/lib/session", () => {
  class WorkspaceChangedError extends Error {}
  return {
    requirePermission: vi.fn(async () => ({ organisationId: "org_a", userId: "u1" })),
    requirePermissionForMutation: vi.fn(async () => ({ organisationId: "org_a", userId: "u1" })),
    jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
    WorkspaceChangedError,
    workspaceChangedJsonResponse: () => Response.json({ error: "changed" }, { status: 409 }),
  };
});

import {
  AUTOMATION_ACTION_OPTIONS,
  AUTOMATION_TRIGGER_OPTIONS,
  AUTOMATION_TRIGGERS,
  EXECUTABLE_AUTOMATION_ACTIONS,
  automationTriggerLabel,
  isExecutableAutomationAction,
  isFiringAutomationTrigger,
} from "@/lib/customer-labels";
import {
  compileNaturalLanguageToWorkflow,
  validateAutomationRule,
} from "@/services/automation-os";
import { PATCH, POST } from "@/app/api/automations/route";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/automations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("automation trigger/action catalogue", () => {
  it("UI trigger options are exactly the triggers that fire", () => {
    expect(AUTOMATION_TRIGGER_OPTIONS.map((o) => o.value)).toEqual(AUTOMATION_TRIGGERS);
    for (const dead of ["conversation_updated", "deal_won", "deal_lost", "message_inbound", "conversation_inactive"]) {
      expect(isFiringAutomationTrigger(dead)).toBe(false);
      // Legacy rules still get a readable label.
      expect(automationTriggerLabel(dead)).not.toMatch(/_/);
    }
  });

  it("every listed trigger is emitted by a runAutomations caller, and every emitted literal is listed", () => {
    const emitterFiles = [
      "src/services/inbound-pipeline.ts",
      "src/services/messaging/ai-reply-follow-through.ts",
      "src/services/booking-webhook.ts",
      "src/services/domain-events/catalogue.ts",
    ];
    const emitters = emitterFiles.map(read).join("\n");
    for (const trigger of AUTOMATION_TRIGGERS) {
      expect(emitters, `trigger ${trigger} is not emitted`).toContain(`"${trigger}"`);
    }
    const inbound = [emitterFiles[0]!, emitterFiles[1]!].map(read).join("\n");
    const literals = [...inbound.matchAll(/triggerType:\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) expect(AUTOMATION_TRIGGERS).toContain(literal);
  });

  it("executable actions match the executeAction switch in automations.ts", () => {
    const source = read("src/services/automations.ts");
    const body = source.slice(source.indexOf("export async function executeAction"));
    const cases = [...body.matchAll(/case\s+"([a-z_]+)":/g)].map((m) => m[1]!);
    expect([...cases].sort()).toEqual([...EXECUTABLE_AUTOMATION_ACTIONS].sort());
  });

  it("UI action options all have executors and exclude publish_content", () => {
    const values = AUTOMATION_ACTION_OPTIONS.map((o) => o.value);
    expect(values).not.toContain("publish_content");
    for (const value of values) expect(isExecutableAutomationAction(value)).toBe(true);
  });
});

describe("NL compile only emits real triggers and executable actions", () => {
  const phrases = [
    "When a lead is qualified, notify the team and send a follow-up in 60 min",
    "If a lead doesn't reply for 30 minutes, send a follow up",
    "When the conversation goes inactive, nudge them",
    "When a lead is disqualified, tag cold",
    "When a meeting is booked, notify the team",
    "When someone DMs asking about price, draft a suggested reply for review",
    "Publish a post every morning",
    "Send booking link to new leads",
  ];
  it.each(phrases)("%s", (phrase) => {
    const wf = compileNaturalLanguageToWorkflow(phrase);
    expect(isFiringAutomationTrigger(wf.triggerType)).toBe(true);
    for (const action of wf.actions) {
      expect(isExecutableAutomationAction(String(action.type))).toBe(true);
    }
    expect(validateAutomationRule(wf)).toBeNull();
  });

  it("maps disqualified before qualified and inactivity onto a firing trigger with a note", () => {
    expect(compileNaturalLanguageToWorkflow("When a lead is disqualified, notify me").triggerType).toBe(
      "lead_disqualified",
    );
    const quiet = compileNaturalLanguageToWorkflow("If a lead has no reply after 30 min, follow up");
    expect(quiet.triggerType).toBe("new_inbound_message");
    expect(quiet.actions).toContainEqual({ type: "send_follow_up", minutes: 30 });
    expect(quiet.unsupportedNotes?.join(" ")).toMatch(/no inactivity trigger/i);
  });
});

describe("validateAutomationRule", () => {
  it("rejects dead triggers, executor-less actions and empty action lists", () => {
    expect(validateAutomationRule({ triggerType: "deal_won" })).toMatch(/Unknown trigger "deal_won"/);
    expect(validateAutomationRule({ actions: [{ type: "publish_content" }] })).toMatch(
      /"publish_content" is not supported/,
    );
    expect(validateAutomationRule({ actions: [{ type: "draft_reply_for_review" }] })).toMatch(/not supported/);
    expect(validateAutomationRule({ actions: [] })).toMatch(/at least one action/);
    expect(
      validateAutomationRule({ triggerType: "lead_qualified", actions: [{ type: "notify_team" }] }),
    ).toBeNull();
  });
});

describe("/api/automations validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ruleCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "rule_1",
      ...data,
    }));
    mocks.ruleUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("POST rejects a trigger that never fires with 400", async () => {
    const res = await post({ name: "Won", triggerType: "deal_won", actions: [{ type: "notify_team" }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown trigger "deal_won"/);
    expect(mocks.ruleCreate).not.toHaveBeenCalled();
  });

  it("POST rejects an action with no executor with 400", async () => {
    const res = await post({
      name: "Publish",
      triggerType: "lead_qualified",
      actions: [{ type: "publish_content" }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/publish_content/);
    expect(mocks.ruleCreate).not.toHaveBeenCalled();
  });

  it("POST creates a valid rule", async () => {
    const res = await post({
      name: "Qualified follow-up",
      triggerType: "lead_qualified",
      actions: [{ type: "send_follow_up" }],
    });
    expect(res.status).toBe(201);
    expect(mocks.ruleCreate).toHaveBeenCalledTimes(1);
    expect(mocks.ruleCreate.mock.calls[0]![0].data).toMatchObject({
      organisationId: "org_a",
      triggerType: "lead_qualified",
      requiresApproval: true,
    });
  });

  it("POST returns a readable 400 for schema errors (not raw zod JSON)", async () => {
    const res = await post({ name: "", triggerType: "lead_qualified", actions: [{ type: "notify_team" }] });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toMatch(/^name: /);
  });

  it("PATCH rejects unknown triggers and executor-less actions; toggling stays allowed", async () => {
    const badTrigger = await patch({ id: "rule_1", triggerType: "conversation_updated" });
    expect(badTrigger.status).toBe(400);
    const badAction = await patch({
      id: "rule_1",
      triggerType: "lead_qualified",
      actions: [{ type: "draft_reply_for_review" }],
    });
    expect(badAction.status).toBe(400);
    expect(mocks.ruleUpdateMany).not.toHaveBeenCalled();

    const toggle = await patch({ id: "rule_1", isActive: false });
    expect(toggle.status).toBe(200);
    expect(mocks.ruleUpdateMany).toHaveBeenCalledWith({
      where: { id: "rule_1", organisationId: "org_a" },
      data: { isActive: false },
    });
  });
});
