#!/usr/bin/env node
/**
 * Fail CI if a real .env file is tracked by git.
 * .env.example is allowed.
 */
const { execSync } = require("child_process");

let tracked = "";
try {
  tracked = execSync("git ls-files", { encoding: "utf8" });
} catch {
  console.error("check-no-env-committed: git ls-files failed");
  process.exit(1);
}

const bad = tracked
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((f) => /(^|\/)\.env($|\.)/.test(f) && !f.endsWith(".env.example"));

if (bad.length) {
  console.error("Refusing to continue: secret env files are tracked:");
  for (const f of bad) console.error(" -", f);
  process.exit(1);
}

console.log("check-no-env-committed: ok");
