import {
  registerBuiltinAgent,
  hasAgent,
  clearAgentRegistry as clearRegistry,
} from "@/agents/registry";
import { echoAgent } from "@/agents/echo";
import { summariseAgent } from "@/agents/summarise";
import { researchAgent } from "@/agents/research";
import { socialListeningAgent } from "@/agents/social-listening";
import { analystAgent } from "@/agents/analyst";
import { criticAgent } from "@/agents/critic";
import { imagingAnalyzeAgent } from "@/agents/imaging-analyze";
import { imagingGenerateAgent } from "@/agents/imaging-generate";
import { crmDeskAgent } from "@/agents/crm-desk";
import { contentWriterAgent } from "@/agents/content-writer";
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
  contentWriterAgent,
];

/** Register built-in agents once (and refresh stale built-ins after a dev hot reload). */
export function ensureAgentsRegistered(): void {
  const allPresent = BUILTIN.every((a) => hasAgent(a.name));
  if (bootstrapped && allPresent) return;
  for (const agent of BUILTIN) {
    registerBuiltinAgent(agent);
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
  contentWriterAgent,
};
export {
  getAgent,
  listAgents,
  registerAgent,
  hasAgent,
  clearAgentRegistry,
} from "@/agents/registry";
export type { Agent, AgentContext, AgentExecuteResult, AgentTier } from "@/agents/types";
