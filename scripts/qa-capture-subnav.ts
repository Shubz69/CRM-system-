import { chromium } from "playwright";
import path from "path";

const BASE = process.env.APP_URL || "http://localhost:3000";
const EMAIL = process.env.E2E_EMAIL || "";
const PASSWORD = process.env.E2E_PASSWORD || "";
const OUT = path.join(process.cwd(), "QA", "final-product-acceptance");

async function main() {
  if (!EMAIL || !PASSWORD) {
    throw new Error("E2E_EMAIL and E2E_PASSWORD are required (no hardcoded QA credentials)");
  }
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "Email" }).pressSequentially(EMAIL, { delay: 10 });
  await page.getByRole("textbox", { name: "Password" }).pressSequentially(PASSWORD, { delay: 10 });
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45_000 });

  const shots: Array<[string, string, number, number, string]> = [
    ["tablet-768", "growth", 768, 900, "/growth"],
    ["tablet-768", "home", 768, 900, "/home"],
    ["tablet-768", "content", 768, 900, "/content"],
    ["tablet", "crm", 1024, 800, "/crm"],
  ];

  for (const [folder, name, width, height, route] of shots) {
    await page.setViewportSize({ width, height });
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const dir = path.join(OUT, folder);
    await import("fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
