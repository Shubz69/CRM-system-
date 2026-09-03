import { registerAgent, hasAgent, clearAgentRegistry as clearRegistry } from "@/agents/registry";
import { echoAgent } from "@/agents/echo";
import { summariseAgent } from "@/agents/summarise";
import { researchAgent } from "@/agents/research";
import { socialListeningAgent } from "@/agents/social-listening";
import { analystAgent } from "@/agents/analyst";
import { criticAgent } from "@/agents/critic";
import { imagingAnalyzeAgent } from "@/agents/imaging-analyze";
import { imagingGenerateAgent } from "@/agents/imaging-generate";
import { crmDeskAgent } from "@/agents/crm-desk";
import type { AnyAgent } from "@/agents/types";
import { ensureBuiltinToolsRegistered } from "@/kernel";

let bootstrapped = false;

const BUILTIN: AnyAgent[] = [
  echoAgent,
  summariseAgent,
  researchAgent,
  socialListeningAgent,
  analystAgent,
  criticAgent,
  imagingAnalyzeAgent,
  imagingGenerateAgent,
  crmDeskAgent,
];

/** Register built-in agents once. */
export function ensureAgentsRegistered(): void {
  const allPresent = BUILTIN.every((a) => hasAgent(a.name));
  if (bootstrapped && allPresent) return;
  for (const agent of BUILTIN) {
    if (!hasAgent(agent.name)) registerAgent(agent);
  }
  ensureBuiltinToolsRegistered();
  bootstrapped = true;
}

/** Test helper */
export function resetAgentBootstrap(): void {
  clearRegistry();
  bootstrapped = false;
}

export {
  echoAgent,
  summariseAgent,
  researchAgent,
  socialListeningAgent,
  analystAgent,
  criticAgent,
  imagingAnalyzeAgent,
  imagingGenerateAgent,
  crmDeskAgent,
};
export {
  getAgent,
  listAgents,
  registerAgent,
  hasAgent,
  clearAgentRegistry,
} from "@/agents/registry";
export type { Agent, AgentContext, AgentExecuteResult, AgentTier } from "@/agents/types";
