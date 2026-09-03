import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  acknowledgeOrgChangedEvent,
  compareWorkspaceRevisions,
  workspaceGateShouldBlock,
  type OrgChangedBroadcast,
} from "@/lib/workspace-client";

const event = (partial: Partial<OrgChangedBroadcast> & { organisationId: string }): OrgChangedBroadcast => ({
  type: "org-changed",
  organisationName: partial.organisationName || "Org",
  ...partial,
});

describe("workspaceGateShouldBlock lifecycle", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not block while session org is unknown (hydration)", () => {
    expect(
      workspaceGateShouldBlock({
        currentOrganisationId: null,
        currentWorkspaceRevision: null,
        event: event({ organisationId: "org-b" }),
      }),
    ).toBe(false);
  });

  it("blocks when another tab switched to a different org", () => {
    expect(
      workspaceGateShouldBlock({
        currentOrganisationId: "org-a",
        currentWorkspaceRevision: "2026-01-01T00:00:00.000Z",
        event: event({
          organisationId: "org-b",
          workspaceRevision: "2026-01-01T00:00:01.000Z",
        }),
      }),
    ).toBe(true);
  });

  it("blocks A→B→A when org matches but loaded revision is behind", () => {
    expect(
      workspaceGateShouldBlock({
        currentOrganisationId: "org-a",
        currentWorkspaceRevision: "2026-01-01T00:00:01.000Z",
        event: event({
          organisationId: "org-a",
          workspaceRevision: "2026-01-01T00:00:03.000Z",
        }),
      }),
    ).toBe(true);
  });

  it("does not block when loaded revision is newer than a stale event (poison fix)", () => {
    expect(
      workspaceGateShouldBlock({
        currentOrganisationId: "org-b",
        currentWorkspaceRevision: "2026-01-01T00:00:05.000Z",
        event: event({
          organisationId: "org-b",
          workspaceRevision: "2026-01-01T00:00:02.000Z",
          changeId: "old-event",
        }),
      }),
    ).toBe(false);
  });

  it("does not block the tab that matches destination org+revision", () => {
    expect(
      workspaceGateShouldBlock({
        currentOrganisationId: "org-b",
        currentWorkspaceRevision: "2026-01-01T00:00:02.000Z",
        event: event({
          organisationId: "org-b",
          workspaceRevision: "2026-01-01T00:00:02.000Z",
        }),
      }),
    ).toBe(false);
  });

  it("does not re-block after acknowledge", () => {
    const ev = event({
      organisationId: "org-b",
      workspaceRevision: "2026-01-01T00:00:02.000Z",
      changeId: "ack-1",
    });
    acknowledgeOrgChangedEvent(ev);
    expect(
      workspaceGateShouldBlock({
        currentOrganisationId: "org-a",
        currentWorkspaceRevision: "2026-01-01T00:00:01.000Z",
        event: ev,
      }),
    ).toBe(false);
  });

  it("compareWorkspaceRevisions orders ISO timestamps", () => {
    expect(compareWorkspaceRevisions("2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z")).toBeLessThan(0);
    expect(compareWorkspaceRevisions("2026-01-01T00:00:02.000Z", "2026-01-01T00:00:02.000Z")).toBe(0);
  });
});
