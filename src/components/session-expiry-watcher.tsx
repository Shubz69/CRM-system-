"use client";

import { useEffect } from "react";

/** Remembers the last reload so a page whose API keeps answering 401 can't reload in a loop. */
const RELOAD_GUARD_KEY = "agentdesk:auth-reload-at";
// Long enough that a page which still 401s after the reload (e.g. a platform admin without a
// workspace) never loops, short enough that a later, separate sign-out is still caught.
const RELOAD_GUARD_MS = 5 * 60_000;

/** Same-origin app API call (not next-auth's own endpoints). */
export function isAppApiRequest(input: RequestInfo | URL, pageHref: string): boolean {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, pageHref);
    return (
      url.origin === new URL(pageHref).origin &&
      url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/api/auth/")
    );
  } catch {
    return false;
  }
}

/** Whether enough time has passed since the last auth reload to try another. */
export function shouldReloadForAuth(lastReloadAt: number, now: number): boolean {
  return now - lastReloadAt > RELOAD_GUARD_MS;
}

function readLastReload(): number {
  try {
    return Number(window.sessionStorage.getItem(RELOAD_GUARD_KEY) || 0) || 0;
  } catch {
    return 0;
  }
}

function writeLastReload(at: number) {
  try {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(at));
  } catch {
    // Storage unavailable (private mode): the in-memory flag still prevents repeats.
  }
}

/**
 * When an app API call answers 401 — the session was ended by an admin, the password was
 * changed elsewhere, the person was removed from the workspace or it was suspended — reload
 * the page so the server sends them to sign-in or the "no workspace" page, instead of leaving
 * them on a desk where every button fails with "Unauthorized".
 */
export function SessionExpiryWatcher() {
  useEffect(() => {
    const original = window.fetch;
    let reloading = false;
    const watched: typeof window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (
        response.status === 401 &&
        !reloading &&
        isAppApiRequest(input, window.location.href) &&
        shouldReloadForAuth(readLastReload(), Date.now())
      ) {
        reloading = true;
        writeLastReload(Date.now());
        window.location.reload();
      }
      return response;
    };
    window.fetch = watched;
    return () => {
      if (window.fetch === watched) window.fetch = original;
    };
  }, []);
  return null;
}
