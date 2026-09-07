/**
 * Host entry for Railway / generic PaaS when the platform runs `npm start`.
 * Production worker uses railway.toml → `npm run worker:prod` directly.
 * Preview-8b Railpack falls through to `npm start` — set AGENT_DESK_PROCESS=worker.
 */
const { spawnSync } = require("child_process");

const mode = (process.env.AGENT_DESK_PROCESS || "").trim().toLowerCase();
const isWorker =
  mode === "worker" ||
  (process.env.NIXPACKS_START_CMD || "").includes("worker:prod") ||
  (process.env.RAILWAY_ENVIRONMENT_NAME || "").toLowerCase() === "preview-8b";

const args = isWorker
  ? ["tsx", "src/workers/index.ts"]
  : ["next", "start"];

const result = spawnSync("npx", args, {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || "production",
  },
  shell: process.platform === "win32",
});

process.exit(result.status == null ? 1 : result.status);
