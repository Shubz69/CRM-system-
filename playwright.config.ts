import { config as loadEnv } from "dotenv";
import path from "path";
import { defineConfig, devices } from "@playwright/test";

loadEnv({ path: path.join(process.cwd(), ".env") });

const baseURL = (
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.APP_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL,
    trace: "on-first-retry",
    ...(bypass
      ? {
          extraHTTPHeaders: {
            "x-vercel-protection-bypass": bypass,
            "x-vercel-set-bypass-cookie": "true",
          },
        }
      : {}),
  },
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
    ? undefined
    : {
        command: "npm run dev",
        url: baseURL.startsWith("http://localhost") ? baseURL : "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 180_000,
      },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
