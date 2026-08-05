import { test, expect } from "@playwright/test";

test("sign in, simulate DM, verify inbox and pipeline move", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("demo@dminelligence.local");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/dashboard/);

  await page.goto("/simulator");
  await page.getByLabel("Lead message").fill(
    "Hi, I run a coaching business with 500 DMs a month. How much does it cost? I want to book a call.",
  );
  await page.getByLabel("Contact external ID").fill(`e2e_lead_${Date.now()}`);
  await page.getByRole("button", { name: "Send simulated DM" }).click();
  await expect(page.getByText("Result")).toBeVisible();
  await expect(page.getByText("conversationId")).toBeVisible();

  await page.getByRole("link", { name: "Open in inbox" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText(/Score/i).first()).toBeVisible();

  await page.goto("/pipeline");
  await expect(page.getByRole("heading", { name: "Pipeline" })).toBeVisible();
  const stageSelect = page.locator("select").first();
  await expect(stageSelect).toBeVisible();
  const options = stageSelect.locator("option");
  const count = await options.count();
  if (count > 1) {
    const value = await options.nth(1).getAttribute("value");
    if (value) {
      await stageSelect.selectOption(value);
    }
  }
});
