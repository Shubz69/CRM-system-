import { test, expect } from "@playwright/test";

/**
 * Content / approvals / research surfaces — skip without E2E credentials.
 */
function e2eCredentials() {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  test.skip(!email || !password, "E2E_EMAIL and E2E_PASSWORD are required");
  return { email: email!, password: password! };
}

async function signIn(page: import("@playwright/test").Page) {
  const { email, password } = e2eCredentials();
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(dashboard|ask|inbox)/, { timeout: 60_000 });
}

test("content page loads and lists pieces API shape", async ({ page }) => {
  await signIn(page);
  await page.goto("/content");
  await expect(page.getByRole("heading", { name: /Content/i })).toBeVisible({
    timeout: 60_000,
  });
});

test("approvals hub loads", async ({ page }) => {
  await signIn(page);
  await page.goto("/approvals");
  await expect(page.getByRole("heading", { name: /Approval/i })).toBeVisible({
    timeout: 60_000,
  });
});

test("research page loads", async ({ page }) => {
  await signIn(page);
  await page.goto("/research");
  await expect(page.getByRole("heading", { name: /Research/i })).toBeVisible({
    timeout: 60_000,
  });
});

test("social intelligence page loads", async ({ page }) => {
  await signIn(page);
  await page.goto("/social-intelligence");
  await expect(
    page.getByRole("heading", { name: /Social intelligence/i }),
  ).toBeVisible({ timeout: 60_000 });
});
