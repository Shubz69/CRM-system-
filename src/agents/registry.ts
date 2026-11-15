import type { AnyAgent } from "@/agents/types";

const agents = new Map<string, AnyAgent>();
/** Names whose current entry was installed by the built-in bootstrap (not a caller/test double). */
const builtinNames = new Set<string>();

function assertLabel(agent: AnyAgent): void {
  if (typeof agent.userFacingLabel !== "function") {
    throw new Error(`Agent ${agent.name} missing userFacingLabel`);
  }
}

export function registerAgent(agent: AnyAgent): void {
  if (agents.has(agent.name)) {
    throw new Error(`Agent already registered: ${agent.name}`);
  }
  assertLabel(agent);
  agents.set(agent.name, agent);
  builtinNames.delete(agent.name);
}

/**
 * Bootstrap registration for built-in agents. Replaces an earlier built-in entry when
 * the module object changed (dev hot reload keeps this registry alive while agent
 * modules reload — the stale agent would otherwise keep running old code). An agent
 * registered explicitly via registerAgent (e.g. a test double) is never replaced.
 */
export function registerBuiltinAgent(agent: AnyAgent): void {
  const existing = agents.get(agent.name);
  if (existing === agent) return;
  if (existing && !builtinNames.has(agent.name)) return;
  assertLabel(agent);
  agents.set(agent.name, agent);
  builtinNames.add(agent.name);
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
  builtinNames.clear();
}
