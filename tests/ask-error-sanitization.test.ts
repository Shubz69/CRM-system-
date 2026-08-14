import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { looksLikeRawDatabaseError } from "@/lib/user-facing-errors";
import {
  WorkspaceAccessError,
  toUserFacingAskError,
} from "@/services/workspace-access";

describe("Ask error sanitization", () => {
  it("detects leaked Prisma / FK messages", () => {
    expect(
      looksLikeRawDatabaseError(
        "Invalid `prisma.agentRun.create()` invocation: Foreign key constraint violated on the constraint: `AgentRun_organisationId_fkey`",
      ),
    ).toBe(true);
    expect(looksLikeRawDatabaseError("Your workspace is no longer available.")).toBe(false);
  });

  it("maps Prisma P2003 to plain English", () => {
    const err = new Prisma.PrismaClientKnownRequestError("fk", {
      code: "P2003",
      clientVersion: "test",
    });
    const msg = toUserFacingAskError(err);
    expect(msg).not.toMatch(/prisma|foreign key|P2003/i);
    expect(msg).toMatch(/workspace|sign in/i);
  });

  it("passes through WorkspaceAccessError messages", () => {
    const err = new WorkspaceAccessError(
      "NO_WORKSPACE_MEMBERSHIP",
      "This account isn't linked to a workspace yet. Ask an admin to add you to a workspace, then sign in again.",
    );
    expect(toUserFacingAskError(err)).toBe(err.message);
  });

  it("scrubs generic Error messages that look like DB dumps", () => {
    const msg = toUserFacingAskError(
      new Error("Foreign key constraint violated on the constraint: AgentRun_organisationId_fkey"),
    );
    expect(msg).not.toMatch(/foreign key|AgentRun/i);
  });
});
