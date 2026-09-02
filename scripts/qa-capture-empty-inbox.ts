/**
 * Temporarily soft-delete QA conversations, capture empty Inbox onboarding,
 * then restore. Local visual QA only.
 */
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();
const BASE = process.env.APP_URL || "http://localhost:3000";
const EMAIL = process.env.E2E_EMAIL || "";
const PASSWORD = process.env.E2E_PASSWORD || "";
if (!EMAIL || !PASSWORD) {
  throw new Error("E2E_EMAIL and E2E_PASSWORD are required (no hardcoded QA credentials)");
}
const OUT = path.join(process.cwd(), "QA", "final-product-acceptance");
const MARKER = new Date("2099-01-01T00:00:00.000Z");

async function main() {
  const org = await prisma.organisation.findFirst({
    where: {
      deletedAt: null,
      isPlatform: false,
      OR: [
        { name: { contains: "Shobhit Agency QA", mode: "insensitive" } },
        { slug: { contains: "shobhit", mode: "insensitive" } },
      ],
    },
  });
  if (!org) throw new Error("QA org not found");

  const ids = (
    await prisma.conversation.findMany({
      where: { organisationId: org.id, deletedAt: null },
      select: { id: true },
    })
  ).map((c) => c.id);

  console.log(`Soft-deleting ${ids.length} conversations for empty capture`);
  await prisma.conversation.updateMany({
    where: { id: { in: ids } },
    data: { deletedAt: MARKER },
  });

  try {
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "Email" }).pressSequentially(EMAIL, { delay: 12 });
    await page.getByRole("textbox", { name: "Password" }).pressSequentially(PASSWORD, { delay: 12 });
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45_000 });
    await page.goto(`${BASE}/inbox`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(1200);
    const onboarding = await page.getByText("Connect messaging to open your inbox").count();
    fs.mkdirSync(path.join(OUT, "desktop"), { recursive: true });
    fs.mkdirSync(path.join(OUT, "mobile"), { recursive: true });
    await page.screenshot({ path: path.join(OUT, "desktop", "inbox-empty.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT, "mobile", "inbox-empty.png"), fullPage: true });
    await browser.close();
    console.log({ onboarding, emptyCaptured: onboarding > 0 });
  } finally {
    await prisma.conversation.updateMany({
      where: { id: { in: ids }, deletedAt: MARKER },
      data: { deletedAt: null },
    });
    console.log("Restored conversations");
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
