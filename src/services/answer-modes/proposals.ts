import type { AgentAnswerMode } from "@prisma/client";
import { createApprovalRequest } from "@/services/automation-os";
import type { ActionAnswer, ActionItem, DeepAnswer } from "./schemas";

const CAPABILITY_LABELS: Record<string, string> = {
  create_opportunity: "Create opportunity",
  create_task: "Create task",
  create_mission: "Create mission",
  draft_content: "Draft content",
  prepare_outreach: "Prepare outreach",
  save_research: "Save research",
  update_business_state: "Update business state",
};

/**
 * Turn ACTION/DEEP capability CTAs into ApprovalRequest proposals.
 * Never executes the consequential action.
 */
export async function attachApprovalProposals(input: {
  organisationId: string;
  agentRunId: string;
  answerMode: AgentAnswerMode;
  output: ActionAnswer | DeepAnswer;
}): Promise<ActionAnswer | DeepAnswer> {
  if (input.answerMode !== "ACTION" && input.answerMode !== "DEEP") {
    return input.output;
  }

  if (input.output.mode === "action") {
    const actions: ActionItem[] = [];
    for (const action of input.output.actions) {
      if (!action.agentDeskCapability) {
        actions.push(action);
        continue;
      }
      const title =
        CAPABILITY_LABELS[action.agentDeskCapability] || action.agentDeskCapability;
      const approvalRequestId = await createApprovalRequest({
        organisationId: input.organisationId,
        kind: "ask_capability_proposal",
        title,
        summary: action.what,
        payload: {
          agentRunId: input.agentRunId,
          capability: action.agentDeskCapability,
          action,
          autoExecute: false,
        },
      });
      actions.push({ ...action, approvalRequestId });
    }
    return { ...input.output, actions };
  }

  // DEEP: attach proposals for nextActions that map to known capabilities.
  const proposals: NonNullable<DeepAnswer["capabilityProposals"]> = [];
  const next = input.output.nextActions ?? [];
  const capabilityByLabel: Record<string, string> = {
    "Create opportunity": "create_opportunity",
    "Create task": "create_task",
    "Create mission": "create_mission",
    "Draft content": "draft_content",
    "Prepare outreach": "prepare_outreach",
    "Save research": "save_research",
    "Update business state": "update_business_state",
  };
  for (const label of next) {
    const capability = capabilityByLabel[label];
    if (!capability) continue;
    const approvalRequestId = await createApprovalRequest({
      organisationId: input.organisationId,
      kind: "ask_capability_proposal",
      title: label,
      summary: `Proposed from deep research run ${input.agentRunId}`,
      payload: {
        agentRunId: input.agentRunId,
        capability,
        autoExecute: false,
      },
    });
    proposals.push({ capability, label, approvalRequestId });
  }

  return {
    ...input.output,
    capabilityProposals: proposals.length ? proposals : undefined,
  };
}
