/**
 * When an app API call answers 401 mid-session (sessions ended by an admin, workspace
 * suspended, member removed) the page reloads once so the server can send the person to
 * sign-in or the "no workspace" page. Only our own API counts, and it never loops.
 */
import { describe, expect, it } from "vitest";
import { isAppApiRequest, shouldReloadForAuth } from "@/components/session-expiry-watcher";

const PAGE = "https://app.example.test/inbox?tab=open";

describe("isAppApiRequest", () => {
  it("counts same-origin /api calls, relative or absolute", () => {
    expect(isAppApiRequest("/api/conversations", PAGE)).toBe(true);
    expect(isAppApiRequest("https://app.example.test/api/leads?x=1", PAGE)).toBe(true);
    expect(isAppApiRequest(new URL("https://app.example.test/api/goals"), PAGE)).toBe(true);
    expect(isAppApiRequest(new Request("https://app.example.test/api/deals"), PAGE)).toBe(true);
  });

  it("ignores next-auth, pages and other sites", () => {
    expect(isAppApiRequest("/api/auth/session", PAGE)).toBe(false);
    expect(isAppApiRequest("/inbox", PAGE)).toBe(false);
    expect(isAppApiRequest("https://api.other.test/api/thing", PAGE)).toBe(false);
  });
});

describe("shouldReloadForAuth", () => {
  it("reloads the first time, then not again for five minutes", () => {
    const now = 1_000_000_000;
    expect(shouldReloadForAuth(0, now)).toBe(true);
    expect(shouldReloadForAuth(now - 30_000, now)).toBe(false);
    expect(shouldReloadForAuth(now - 6 * 60_000, now)).toBe(true);
  });
});
