import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    agentMission: { findFirst: vi.fn() },
    stateSnapshot: { findMany: vi.fn(async () => []) },
    goal: { findFirst: vi.fn() },
    businessOpportunity: { findFirst: vi.fn() },
    decision: { findFirst: vi.fn() },
    intelligenceClaim: { findMany: vi.fn(async () => []) },
    toolTrustRecord: {
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async ({ create, update }: { create: unknown; update: unknown }) => ({
        ...(create as object),
        ...(update as object),
      })),
    },
  },
}));

vi.mock("@/services/knowledge", () => ({
  retrieveRelevantKnowledge: vi.fn(async () => ({
    chunks: [],
    documentTitles: [],
    mode: "lexical",
  })),
}));

import { prisma } from "@/lib/db";
import {
  clearToolRegistry,
  registerTool,
} from "@/kernel/tool-registry";
import { planContext } from "@/services/context-resolver";
import {
  shortlistTools,
  upsertToolTrust,
} from "@/services/tool-trust";

const mcpTool = {
  name: "mcp.lookup",
  version: "2.0.0",
  description: "Look up external records",
  risk: "read" as const,
  costClass: "cheap" as const,
};

describe("Phase 20H context and tool trust", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.stateSnapshot.findMany).mockResolvedValue([]);
    vi.mocked(prisma.intelligenceClaim.findMany).mockResolvedValue([]);
  });

  it("quarantines an MCP tool when its definition hash changes", async () => {
    vi.mocked(prisma.toolTrustRecord.findUnique).mockResolvedValueOnce({
      id: "trust_1",
      organisationId: "org_1",
      toolKey: mcpTool.name,
      provider: "mcp",
      origin: "mcp",
      version: "1.0.0",
      definitionHash: "old-hash",
      permissions: [],
      dataClasses: [],
      sideEffects: [],
      externalDestinations: [],
      riskLevel: "read",
      approvalRequired: false,
      allowedAgentTypes: [],
      status: "TRUSTED",
      lastInspectionAt: null,
      verificationNote: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await upsertToolTrust({
      organisationId: "org_1",
      tool: mcpTool,
      provider: "mcp",
      origin: "mcp",
    });

    expect(prisma.toolTrustRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "QUARANTINED",
          verificationNote: expect.stringMatching(/re-verification/i),
        }),
      }),
    );
  });

  it("excludes blocked tools from available and shortlisted tools", async () => {
    clearToolRegistry();
    registerTool(mcpTool);
    vi.mocked(prisma.toolTrustRecord.findMany).mockResolvedValueOnce([
      {
        id: "trust_2",
        organisationId: "org_1",
        toolKey: mcpTool.name,
        provider: "mcp",
        origin: "mcp",
        version: mcpTool.version,
        definitionHash: "hash",
        permissions: [],
        dataClasses: [],
        sideEffects: [],
        externalDestinations: [],
        riskLevel: "read",
        approvalRequired: false,
        allowedAgentTypes: [],
        status: "BLOCKED",
        lastInspectionAt: null,
        verificationNote: "blocked by admin",
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const result = await shortlistTools({
      organisationId: "org_1",
      requiredCapabilities: ["lookup"],
    });

    expect(result.available).not.toContainEqual(expect.objectContaining({ name: mcpTool.name }));
    expect(result.shortlisted).not.toContainEqual(expect.objectContaining({ name: mcpTool.name }));
    expect(result.rejected).toContainEqual({
      tool: expect.objectContaining({ name: mcpTool.name }),
      reason: "Trust status BLOCKED",
    });
  });

  it("trims context without dumping an entire state payload", async () => {
    vi.mocked(prisma.stateSnapshot.findMany).mockResolvedValueOnce([
      {
        dimension: "pipeline",
        value: "x".repeat(3_000),
        numericValue: null,
        reasonCode: "CURRENT",
        asOf: new Date("2026-08-24T12:00:00Z"),
      },
    ]);

    const result = await planContext({
      organisationId: "org_1",
      entityType: "organisation",
      entityId: "org_1",
      maxTokens: 64,
    });

    expect(result.estimatedTokens).toBeLessThanOrEqual(64);
    expect(result.truncated).toBe(true);
    expect(result.items[0]?.source).toBe("state");
  });
});
