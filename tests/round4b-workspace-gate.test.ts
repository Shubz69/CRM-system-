import { describe, expect, it } from "vitest";
import { workspaceGateShouldBlock } from "@/lib/workspace-client";

describe("workspaceGateShouldBlock", () => {
  it("does not block while session org is unknown (hydration)", () => {
    expect(
      workspaceGateShouldBlock({
        currentOrganisationId: null,
        currentWorkspaceRevision: null,
        event: {
          type: "org-changed",
          organisationId: "org-b",
          organisationName: "B",
        },
      }),
    ).toBe(false);
  });

  it("blocks when another tab switched to a different org", () => {
    expect(
      workspaceGateShouldBlock({
        currentOrganisationId: "org-a",
        currentWorkspaceRevision: "rev-1",
        event: {
          type: "org-changed",
          organisationId: "org-b",
          organisationName: "B",
          workspaceRevision: "rev-2",
        },
      }),
    ).toBe(true);
  });

  it("blocks A→B→A when org matches but revision differs", () => {
    expect(
      workspaceGateShouldBlock({
        currentOrganisationId: "org-a",
        currentWorkspaceRevision: "rev-1",
        event: {
          type: "org-changed",
          organisationId: "org-a",
          organisationName: "A",
          workspaceRevision: "rev-3",
        },
      }),
    ).toBe(true);
  });

  it("does not block the tab that just switched to the matching org+revision", () => {
    expect(
      workspaceGateShouldBlock({
        currentOrganisationId: "org-b",
        currentWorkspaceRevision: "rev-2",
        event: {
          type: "org-changed",
          organisationId: "org-b",
          organisationName: "B",
          workspaceRevision: "rev-2",
        },
      }),
    ).toBe(false);
  });
});
