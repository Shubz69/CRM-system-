import { test, expect } from "@playwright/test";

/**
 * Super Admin navigation smoke.
 * Requires E2E_EMAIL / E2E_PASSWORD for a platform admin user.
 */
async function signIn(page: import("@playwright/test").Page) {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  test.skip(!email || !password, "E2E_EMAIL and E2E_PASSWORD are required");
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(email!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(dashboard|ask|account|admin)/, { timeout: 60_000 });
}

const ADMIN_ROUTES = [
  { label: "Platform Overview", path: "/admin" },
  { label: "Workspaces", path: "/admin/workspaces" },
  { label: "Users", path: "/admin/users" },
  { label: "AI Usage", path: "/admin/usage" },
  { label: "System Health", path: "/admin/health" },
  { label: "Webhook Events", path: "/admin/webhooks" },
  { label: "Failed Jobs", path: "/admin/failed-jobs" },
  { label: "Audit Logs", path: "/admin/audit" },
  { label: "Global Settings", path: "/admin/settings" },
];

test.describe("Super Admin routes", () => {
  test("every admin sidebar item renders without runtime exceptions", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await signIn(page);

    // Prefer clicking sidebar when Super Admin nav is visible
    const adminHeading = page.getByText("Super Admin", { exact: false });
    const hasAdminNav = await adminHeading.isVisible().catch(() => false);

    for (const route of ADMIN_ROUTES) {
      if (hasAdminNav) {
        await page.getByRole("link", { name: route.label, exact: true }).click();
      } else {
        await page.goto(route.path);
      }

      await expect(page).toHaveURL(new RegExp(route.path.replace(/\//g, "\\/")));
      // Redirect to dashboard means permission denied — fail loudly
      await expect(page).not.toHaveURL(/\/dashboard$/);
      await expect(page.locator("main")).toBeVisible();
      await expect(page.locator("main")).not.toContainText("Application error");
      // Soft reload preserves access
      await page.reload();
      await expect(page).toHaveURL(new RegExp(route.path.replace(/\//g, "\\/")));
      await expect(page.locator("main")).toBeVisible();
    }

    expect(pageErrors, `Page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  });

  test("workspaces create form is interactive", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/workspaces");
    if (page.url().includes("/dashboard")) {
      test.skip(true, "User is not platform admin in this environment");
    }
    await expect(page.locator("main").getByRole("heading", { name: "Workspaces" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole("button", { name: /Create workspace/i })).toBeVisible();
  });

  test("autopilot and needs attention routes work for workspace users", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await signIn(page);

    await page.goto("/autopilot");
    await expect(page.locator("main").getByRole("heading", { name: "Autopilot" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(/Capability modes|LIVE|OFF|TEST MODE|PAUSED/i).first()).toBeVisible();

    await page.goto("/attention");
    await expect(page.locator("main").getByRole("heading", { name: /Needs Attention/i })).toBeVisible();

    await page.goto("/settings/go-live");
    await expect(page.locator("main").getByRole("heading", { name: /Go Live/i })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
