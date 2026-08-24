import type { ToolDefinition } from "@/kernel/types";

const tools = new Map<string, ToolDefinition>();

export function registerTool(def: ToolDefinition): void {
  if (!def.name?.trim()) {
    throw new Error("ToolDefinition.name is required");
  }
  tools.set(def.name, def);
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name);
}

export function listTools(): ToolDefinition[] {
  return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function clearToolRegistry(): void {
  tools.clear();
}

let builtinsRegistered = false;

/**
 * Register first-party tools that wrap existing adapters.
 * Idempotent — safe to call from boot paths and tests.
 */
export function ensureBuiltinToolsRegistered(): void {
  if (builtinsRegistered && tools.size > 0) return;

  registerTool({
    name: "sources.search",
    version: "1.0.0",
    description:
      "Search configured research sources (YouTube, web, Reddit, Apify social platforms) for a query.",
    risk: "read",
    costClass: "metered",
    requiredPermission: "ask:use",
    requiredCredential: "YOUTUBE_API_KEY | TAVILY_API_KEY | APIFY_TOKEN | …",
    timeoutMs: 120_000,
    platforms: ["youtube", "web", "reddit", "instagram", "linkedin", "tiktok", "twitter", "threads"],
  });

  registerTool({
    name: "knowledge.retrieve",
    version: "1.0.0",
    description: "Retrieve organisation knowledge chunks for grounding (lexical + embeddings).",
    risk: "read",
    costClass: "cheap",
    requiredPermission: "ask:use",
    timeoutMs: 15_000,
  });

  registerTool({
    name: "memory.retrieve",
    version: "1.0.0",
    description:
      "Retrieve episodic Ask memory and organisation preferences (not approved Knowledge).",
    risk: "read",
    costClass: "cheap",
    requiredPermission: "ask:use",
    timeoutMs: 10_000,
  });

  registerTool({
    name: "trends.refresh",
    version: "1.0.0",
    description: "Refresh trend clusters and probabilistic forecasts from recent social evidence.",
    risk: "read",
    costClass: "cheap",
    requiredPermission: "insights:read",
    timeoutMs: 60_000,
  });

  registerTool({
    name: "content.propose",
    version: "1.0.0",
    description:
      "Create a content opportunity from research evidence (whyEvidence required). Does not publish.",
    risk: "write_internal",
    costClass: "cheap",
    requiredPermission: "ask:use",
    timeoutMs: 15_000,
  });

  registerTool({
    name: "automation.compile",
    version: "1.0.0",
    description: "Compile natural language into a visible automation workflow (does not enable).",
    risk: "write_internal",
    costClass: "cheap",
    requiredPermission: "automations:manage",
    timeoutMs: 10_000,
  });

  registerTool({
    name: "learning.eval",
    version: "1.0.0",
    description:
      "Run deterministic regression evals for agent version candidates (does not promote).",
    risk: "write_internal",
    costClass: "cheap",
    requiredPermission: "agent:manage",
    timeoutMs: 30_000,
  });

  registerTool({
    name: "crm.read_conversation",
    version: "1.0.0",
    description: "Read conversation and messages within the active organisation.",
    risk: "read",
    costClass: "free",
    requiredPermission: "inbox:read",
    timeoutMs: 10_000,
  });

  registerTool({
    name: "messaging.send",
    version: "1.0.0",
    description: "Send an outbound message via configured messaging adapter (e.g. ManyChat).",
    risk: "outbound_message",
    costClass: "metered",
    requiredPermission: "inbox:write",
    requiredCredential: "MANYCHAT_API_TOKEN",
    timeoutMs: 30_000,
  });

  registerTool({
    name: "social.publish",
    version: "1.0.0",
    description: "Publish or schedule content via a connected social OAuth account.",
    risk: "publish",
    costClass: "metered",
    requiredPermission: "integrations:manage",
    requiredCredential: "SocialConnection",
    timeoutMs: 60_000,
    platforms: ["instagram", "linkedin", "tiktok"],
  });

  registerTool({
    name: "manychat.send_message",
    version: "1.0.0",
    description: "Send via ManyChat connector operation (policy + capability gated).",
    risk: "outbound_message",
    costClass: "metered",
    requiredPermission: "inbox:write",
    requiredCredential: "MANYCHAT_API_TOKEN",
    timeoutMs: 30_000,
    platforms: ["manychat"],
  });

  registerTool({
    name: "tavily.search_web",
    version: "1.0.0",
    description: "Web search via Tavily/Exa connector (untrusted results = data).",
    risk: "read",
    costClass: "metered",
    requiredPermission: "ask:use",
    requiredCredential: "TAVILY_API_KEY | EXA_API_KEY",
    timeoutMs: 30_000,
    platforms: ["tavily"],
  });

  registerTool({
    name: "linkedin.publish_post",
    version: "1.0.0",
    description: "LinkedIn member-feed publish via connector (Phase 15 worker E2E).",
    risk: "publish",
    costClass: "metered",
    requiredPermission: "integrations:manage",
    requiredCredential: "SocialConnection",
    timeoutMs: 120_000,
    platforms: ["linkedin"],
  });

  registerTool({
    name: "imaging.generate",
    version: "1.0.0",
    description: "Generate an image after user prompt confirmation.",
    risk: "write_internal",
    costClass: "expensive",
    requiredPermission: "ask:use",
    requiredCredential: "OPENAI_API_KEY | GEMINI_API_KEY",
    timeoutMs: 120_000,
  });

  builtinsRegistered = true;
}
