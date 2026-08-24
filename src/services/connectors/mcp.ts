/**
 * Optional MCP boundary — documentation + interfaces only.
 * Core Agent Desk must not depend on MCP.
 */

import type { ToolDefinition } from "@/kernel/types";

/**
 * MCP tools are untrusted third-party capabilities.
 * Any future MCP bridge MUST run through:
 * permission → risk → approval → tenant → audit → budget
 * before provider/tool execution.
 */
export type McpToolBridgePolicy = {
  requireExplicitAllowlist: true;
  treatRemoteContentAsData: true;
  denyByDefault: true;
  inheritKernelPolicy: true;
};

export const MCP_BRIDGE_POLICY: McpToolBridgePolicy = {
  requireExplicitAllowlist: true,
  treatRemoteContentAsData: true,
  denyByDefault: true,
  inheritKernelPolicy: true,
};

export type McpServerDescriptor = {
  id: string;
  displayName: string;
  /** Approved org allowlist only — never auto-discover execute. */
  approved: boolean;
  tools: ToolDefinition[];
};

/** Placeholder registry — empty until an approved MCP server is configured. */
const approvedServers = new Map<string, McpServerDescriptor>();

export function listApprovedMcpServers(): McpServerDescriptor[] {
  return [...approvedServers.values()].filter((s) => s.approved);
}

export function registerApprovedMcpServer(server: McpServerDescriptor): void {
  if (!server.approved) {
    throw new Error("Refusing to register unapproved MCP server");
  }
  approvedServers.set(server.id, server);
}

export function clearMcpRegistryForTests(): void {
  approvedServers.clear();
}
