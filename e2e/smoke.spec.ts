import { test, expect } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("demo@dminelligence.local");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/dashboard/);
}

test("sign in, simulate DM, verify inbox and pipeline move", async ({ page }) => {
  await signIn(page);

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

test("opt-out via simulator stop keyword", async ({ page }) => {
  await signIn(page);
  const externalId = `e2e_optout_${Date.now()}`;

  await page.goto("/simulator");
  await page.getByLabel("Lead message").fill("Please stop messaging me");
  await page.getByLabel("Contact external ID").fill(externalId);
  await page.getByRole("button", { name: "Send simulated DM" }).click();
  await expect(page.getByText("Result")).toBeVisible();
  await expect(page.getByText(/optedOut|true/i).first()).toBeVisible({ timeout: 15_000 });
});

test("knowledge create and list", async ({ page }) => {
  await signIn(page);
  await page.goto("/knowledge");
  await expect(page.getByRole("heading", { name: /Knowledge/i })).toBeVisible();

  const title = `E2E FAQ ${Date.now()}`;
  await page.getByLabel("Title").first().fill(title);
  await page.locator("textarea").first().fill("Prospects often ask about onboarding timelines.");
  await page.getByRole("button", { name: "Save document" }).click();
  await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 });
});

test("reports generate and export csv", async ({ page }) => {
  await signIn(page);
  await page.goto("/reports");
  await page.getByRole("button", { name: "Generate daily report" }).click();
  await expect(page.locator("pre")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Export CSV" }).click();
});

test("insights content suggestions render after traffic", async ({ page }) => {
  await signIn(page);
  await page.goto("/simulator");
  await page.getByLabel("Lead message").fill(
    "Is this expensive? What is the pricing for agencies? I need to book soon.",
  );
  await page.getByLabel("Contact external ID").fill(`e2e_insights_${Date.now()}`);
  await page.getByRole("button", { name: "Send simulated DM" }).click();
  await expect(page.getByText("Result")).toBeVisible();

  await page.goto("/insights");
  await expect(page.getByRole("heading", { name: "Insights" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Content ideas" })).toBeVisible();
});

test("organisation switcher appears for multi-org demo user", async ({ page }) => {
  await signIn(page);
  const switcher = page.getByLabel("Switch organisation");
  await expect(switcher).toBeVisible();
  await switcher.selectOption({ label: "Northstar Studio" });
  await expect(page.getByLabel("Switch organisation")).toHaveValue(/.+/);
});
