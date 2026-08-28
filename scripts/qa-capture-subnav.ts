import { chromium } from "playwright";
import path from "path";

const BASE = process.env.APP_URL || "http://localhost:3000";
const OUT = path.join(process.cwd(), "QA", "final-product-acceptance");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "Email" }).pressSequentially("1230shobhit@gmail.com", { delay: 10 });
  await page.getByRole("textbox", { name: "Password" }).pressSequentially("AcceptQA-2026-ux!", { delay: 10 });
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45_000 });

  const shots: Array<[string, string, number, number, string]> = [
    ["tablet-768", "growth", 768, 900, "/growth"],
    ["tablet-768", "home", 768, 900, "/home"],
    ["tablet-768", "content", 768, 900, "/content"],
    ["tablet", "crm", 1024, 800, "/crm"],
    ["tablet", "pipeline", 1024, 800, "/pipeline"],
    ["tablet", "inbox", 1024, 800, "/inbox"],
    ["mobile", "growth", 390, 844, "/growth"],
    ["desktop", "growth", 1440, 900, "/growth"],
    ["laptop", "growth", 1280, 800, "/growth"],
  ];
  for (const [folder, name, w, h, route] of shots) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, folder, `${name}.png`), fullPage: true });
    console.log("shot", folder, name);
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
