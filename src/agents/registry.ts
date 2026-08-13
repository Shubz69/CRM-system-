import type { Agent, AnyAgent } from "@/agents/types";

const agents = new Map<string, AnyAgent>();

export function registerAgent(agent: AnyAgent): void {
  if (agents.has(agent.name)) {
    throw new Error(`Agent already registered: ${agent.name}`);
  }
  if (typeof agent.userFacingLabel !== "function") {
    throw new Error(`Agent ${agent.name} missing userFacingLabel`);
  }
  agents.set(agent.name, agent);
}

export function getAgent(name: string): AnyAgent {
  const agent = agents.get(name);
  if (!agent) {
    throw new Error(`Unknown agent: ${name}`);
  }
  return agent;
}

export function listAgents(): AnyAgent[] {
  return [...agents.values()];
}

export function hasAgent(name: string): boolean {
  return agents.has(name);
}

/** Test helper — clears the registry. */
export function clearAgentRegistry(): void {
  agents.clear();
}
