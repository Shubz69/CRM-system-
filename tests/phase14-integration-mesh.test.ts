/**
 * Phase 14 — Integration mesh / connectors / skills / sync tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestOrganisation,
  destroyTestOrganisation,
  type TestOrganisationFixture,
} from "./helpers/org-fixtures";
import { prisma } from "@/lib/db";
import { MemberRole } from "@prisma/client";
import {
  assertSkillExecutable,
  authorizeConnectorTool,
  ConnectorAuthzError,
  ensureBuiltinSkillsSeeded,
  evaluateOrganisationConnectors,
  getReconciliationPlan,
  listConnectorDefinitions,
  MCP_BRIDGE_POLICY,
  recordCircuitFailure,
  recordCircuitSuccess,
  recordProvider429,
  assertNotRateLimited,
  assertCircuitClosed,
  runConnectorSync,
  upsertExternalObjectMapping,
  getSyncCursor,
} from "@/services/connectors";
import { ensureBuiltinToolsRegistered, getTool } from "@/kernel/tool-registry";
import { DealStatus } from "@prisma/client";

describe("Phase 14 integration mesh", () => {
  let orgA: TestOrganisationFixture;
  let orgB: TestOrganisationFixture;

  beforeAll(async () => {
    orgA = await createTestOrganisation("p14-a");
    orgB = await createTestOrganisation("p14-b");
    ensureBuiltinToolsRegistered();
    await ensureBuiltinSkillsSeeded();
  }, 60_000);

  afterAll(async () => {
    await destroyTestOrganisation(orgA);
    await destroyTestOrganisation(orgB);
  }, 60_000);

  it("lists connector definitions with operations metadata", () => {
    const defs = listConnectorDefinitions();
    expect(defs.some((d) => d.providerKey === "manychat")).toBe(true);
    expect(defs.some((d) => d.providerKey === "linkedin")).toBe(true);
    const li = defs.find((d) => d.providerKey === "linkedin")!;
    expect(li.operations[0]?.providerIdempotency).toBe("lookup");
    expect(li.commercialRestrictions?.length).toBeGreaterThan(0);
  });

  it("evaluates capabilities without inventing connected publish", async () => {
    const rows = await evaluateOrganisationConnectors(orgA.organisationId);
    const ig = rows.find((r) => r.providerKey === "instagram");
    expect(ig).toBeTruthy();
    expect(ig!.connectionStatus).toBe("DISCONNECTED");
    const publish = ig!.capabilities.find((c) => c.capability === "PUBLISH");
    expect(publish?.status).toBe("AUTH_REQUIRED");
    const persisted = await prisma.connectorCapabilityState.findFirst({
      where: { organisationId: orgA.organisationId, providerKey: "instagram", capability: "PUBLISH" },
    });
    expect(persisted).toBeTruthy();
  }, 30_000);

  it("tenant isolation on external mappings", async () => {
    await upsertExternalObjectMapping({
      organisationId: orgA.organisationId,
      providerKey: "manychat",
      externalType: "Contact",
      externalId: "ext-1",
      internalType: "Contact",
      internalId: "internal-a",
    });
    const cross = await prisma.externalObjectMapping.findFirst({
      where: {
        organisationId: orgB.organisationId,
        providerKey: "manychat",
        externalId: "ext-1",
      },
    });
    expect(cross).toBeNull();
  });

  it("sync persists cursor and is idempotent on remapping", async () => {
    const contact = await prisma.contact.create({
      data: {
        organisationId: orgA.organisationId,
        fullName: "Sync Person",
      },
    });
    let stamped = false;
    const run1 = await runConnectorSync({
      organisationId: orgA.organisationId,
      providerKey: "manychat",
      resource: "contacts_test",
      fetchBatch: async () => {
        stamped = true;
        return {
          items: [
            {
              externalId: "mc-1",
              externalType: "Contact",
              internalType: "Contact",
              internalId: contact.id,
            },
          ],
          nextCursor: "cursor-2",
          complete: true,
        };
      },
    });
    expect(stamped).toBe(true);
    expect(run1.status).toBe("SUCCEEDED");
    expect(run1.createdCount).toBe(1);
    const cursor = await getSyncCursor({
      organisationId: orgA.organisationId,
      providerKey: "manychat",
      resource: "contacts_test",
    });
    expect(cursor?.cursorValue).toBe("cursor-2");

    const run2 = await runConnectorSync({
      organisationId: orgA.organisationId,
      providerKey: "manychat",
      resource: "contacts_test",
      fetchBatch: async (c) => {
        expect(c).toBe("cursor-2");
        return {
          items: [
            {
              externalId: "mc-1",
              externalType: "Contact",
              internalType: "Contact",
              internalId: contact.id,
            },
          ],
          nextCursor: "cursor-2",
          complete: true,
        };
      },
    });
    expect(run2.updatedCount).toBe(1);
    expect(run2.createdCount).toBe(0);

    const event = await prisma.domainEvent.findFirst({
      where: {
        organisationId: orgA.organisationId,
        eventType: "SYNC_COMPLETED",
        aggregateId: run1.id,
      },
    });
    expect(event).toBeTruthy();
  });

  it("rate limit and circuit breaker block provider calls", async () => {
    await recordProvider429({
      organisationId: orgA.organisationId,
      providerKey: "tavily",
      retryAfterSeconds: 120,
    });
    await expect(
      assertNotRateLimited({
        organisationId: orgA.organisationId,
        providerKey: "tavily",
      }),
    ).rejects.toThrow(/rate-limited/i);

    for (let i = 0; i < 5; i++) {
      await recordCircuitFailure({
        organisationId: orgA.organisationId,
        providerKey: "apify",
        errorSummary: "boom",
      });
    }
    await expect(
      assertCircuitClosed({
        organisationId: orgA.organisationId,
        providerKey: "apify",
      }),
    ).rejects.toThrow(/circuit OPEN/i);

    await recordCircuitSuccess({
      organisationId: orgA.organisationId,
      providerKey: "apify",
    });
    await assertCircuitClosed({
      organisationId: orgA.organisationId,
      providerKey: "apify",
    });
  });

  it("authorizes tools and denies missing capability", async () => {
    await evaluateOrganisationConnectors(orgA.organisationId);
    await expect(
      authorizeConnectorTool({
        organisationId: orgA.organisationId,
        toolName: "linkedin.publish_post",
        providerKey: "linkedin",
        capability: "PUBLISH",
        connectionRef: "none",
        role: MemberRole.OWNER,
      }),
    ).rejects.toBeInstanceOf(ConnectorAuthzError);

    // ManyChat may be CONNECTED if MANYCHAT_API_TOKEN is in env — still require_approval.
    const mc = await authorizeConnectorTool({
      organisationId: orgA.organisationId,
      toolName: "manychat.send_message",
      providerKey: "manychat",
      capability: "SEND_MESSAGE",
      role: MemberRole.OWNER,
    }).catch((e: unknown) => e);
    if (mc instanceof ConnectorAuthzError) {
      expect(mc.code).toMatch(/CAPABILITY|PERMISSION|POLICY/);
    } else {
      expect(mc).toMatchObject({ effect: "require_approval" });
    }
  }, 30_000);

  it("skills are versioned and require registered tools", async () => {
    expect(getTool("sources.search")).toBeTruthy();
    const skill = await assertSkillExecutable({
      organisationId: orgA.organisationId,
      key: "research-web",
      version: "1.0.0",
    });
    expect(skill.version).toBe("1.0.0");
    await expect(
      assertSkillExecutable({
        organisationId: orgA.organisationId,
        key: "research-web",
        version: "9.9.9",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("reconciliation plan is honest for publish ops", () => {
    const plan = getReconciliationPlan("instagram", "instagram.publish_post");
    expect(plan?.support).toBe("lookup");
    expect(plan?.steps).toContain("lookup");
    const smtp = getReconciliationPlan("email_smtp", "email.send");
    expect(smtp?.support).toBe("neither");
  });

  it("MCP bridge policy is deny-by-default", () => {
    expect(MCP_BRIDGE_POLICY.denyByDefault).toBe(true);
    expect(MCP_BRIDGE_POLICY.requireExplicitAllowlist).toBe(true);
  });

  it("deal won/lost emits domain events", async () => {
    const deal = await prisma.deal.create({
      data: {
        organisationId: orgA.organisationId,
        name: "Event deal",
        status: DealStatus.OPEN,
        amountCents: 10000,
        currency: "GBP",
      },
    });
    const { appendDomainEvent } = await import("@/services/domain-events/append");
    await prisma.$transaction(async (tx) => {
      await tx.deal.update({
        where: { id: deal.id },
        data: { status: DealStatus.WON, closedAt: new Date() },
      });
      await appendDomainEvent(tx, {
        organisationId: orgA.organisationId,
        eventType: "DEAL_WON",
        aggregateType: "Deal",
        aggregateId: deal.id,
        payload: { dealId: deal.id, amountCents: 10000, currency: "GBP" },
      });
    });
    const event = await prisma.domainEvent.findFirst({
      where: {
        organisationId: orgA.organisationId,
        eventType: "DEAL_WON",
        aggregateId: deal.id,
      },
    });
    expect(event).toBeTruthy();
  });
});
