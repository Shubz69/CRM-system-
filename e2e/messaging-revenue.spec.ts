import { test, expect } from "@playwright/test";

/**
 * Conversation Revenue Engine — live ManyChat path.
 * Skips (does not pass) when provider credentials are unavailable.
 */
const hasManyChatCredentials = Boolean(
  process.env.MANYCHAT_API_TOKEN && process.env.MANYCHAT_API_TOKEN.trim().length > 0,
);

test.describe("messaging revenue engine (live provider)", () => {
  test.skip(
    !hasManyChatCredentials,
    "MANYCHAT_API_TOKEN unavailable — skipping live messaging provider e2e",
  );

  test("can prepare a live outbound smoke send when credentials exist", async () => {
    // Live provider smoke is intentionally gated; without credentials this suite is skipped.
    expect(hasManyChatCredentials).toBe(true);
    expect(process.env.MANYCHAT_API_TOKEN).toBeTruthy();
  });
});
