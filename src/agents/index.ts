import { registerAgent, hasAgent, clearAgentRegistry as clearRegistry } from "@/agents/registry";
import { echoAgent } from "@/agents/echo";
import { summariseAgent } from "@/agents/summarise";

let bootstrapped = false;

/** Register the built-in agents once. Only Echo and Summarise in Prompt 2B. */
export function ensureAgentsRegistered(): void {
  if (bootstrapped && hasAgent(echoAgent.name) && hasAgent(summariseAgent.name)) {
    return;
  }
  if (!hasAgent(echoAgent.name)) registerAgent(echoAgent);
  if (!hasAgent(summariseAgent.name)) registerAgent(summariseAgent);
  bootstrapped = true;
}

/** Test helper */
export function resetAgentBootstrap(): void {
  clearRegistry();
  bootstrapped = false;
}

export { echoAgent, summariseAgent };
export {
  getAgent,
  listAgents,
  registerAgent,
  hasAgent,
  clearAgentRegistry,
} from "@/agents/registry";
export type { Agent, AgentContext, AgentExecuteResult, AgentTier } from "@/agents/types";
