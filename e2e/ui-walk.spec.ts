import { test, expect } from "@playwright/test";

const WORKSPACE_HREFS = [
  "/ask",
  "/inbox",
  "/pipeline",
  "/contacts",
  "/knowledge",
  "/insights",
  "/reports",
  "/agent",
  "/integrations",
  "/settings",
  "/settings/go-live",
  "/dashboard",
  "/attention",
  "/setup",
  "/autopilot",
  "/automations",
  "/qualification",
  "/simulator",
];

test("public pages render without a Next.js error overlay", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Agent Desk").first()).toBeVisible();

  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.goto("/forgot-password");
  await expect(page.getByRole("heading", { name: "Reset password" })).toBeVisible();
});

test("unauthenticated app routes send the user to login", async ({ page }) => {
  await page.goto("/ask");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("signed-in walk of every workspace page", async ({ page }) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  test.skip(!email || !password, "E2E_EMAIL and E2E_PASSWORD are required");

  await page.goto("/login");
  await page.getByLabel("Email").fill(email!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(dashboard|ask|inbox)/, { timeout: 60_000 });

  for (const href of WORKSPACE_HREFS) {
    await page.goto(href);
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Application error")).toHaveCount(0);
  }
});

test("notifications panel opens", async ({ page }) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  test.skip(!email || !password, "E2E_EMAIL and E2E_PASSWORD are required");

  await page.goto("/login");
  await page.getByLabel("Email").fill(email!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(dashboard|ask|inbox)/, { timeout: 60_000 });

  await page.getByRole("button", { name: /Notifications/ }).click();
  await expect(page.getByRole("dialog", { name: "Notifications" })).toBeVisible();
});
