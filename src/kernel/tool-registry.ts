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
