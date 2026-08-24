#!/usr/bin/env node
/**
 * Safe legacy BullMQ key cleanup for Agent Desk Redis namespaces.
 *
 * Dry-run by default. Use --apply to delete.
 * Never FLUSHDB. Never logs REDIS_URL / tokens.
 * Inspects only known Agent Desk prefixes.
 *
 *   npx tsx scripts/cleanup-bullmq-legacy.ts
 *   npx tsx scripts/cleanup-bullmq-legacy.ts --apply
 *   npx tsx scripts/cleanup-bullmq-legacy.ts --prefix=agentdesk-dev --apply
 */
import IORedis from "ioredis";

const KNOWN_PREFIXES = [
  "agentdesk-dev",
  "agentdesk-test",
  "agentdesk-preview",
  "agentdesk-prod",
  "bull", // legacy default BullMQ prefix (pre-namespace)
];

const LOGICAL_QUEUES = ["agent-runs", "follow-ups", "maintenance"];

function parseArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const prefixArg = argv.find((a) => a.startsWith("--prefix="));
  const prefix = prefixArg ? prefixArg.slice("--prefix=".length) : null;
  return { apply, prefix };
}

function redisUrl(): string {
  return (process.env.REDIS_URL || "redis://localhost:6379").trim();
}

function isAllowedPrefix(p: string): boolean {
  return KNOWN_PREFIXES.includes(p) || /^agentdesk-[a-z0-9-]+$/i.test(p);
}

async function main() {
  const { apply, prefix: onlyPrefix } = parseArgs(process.argv.slice(2));
  const url = redisUrl();
  if (/upstash\.io/i.test(url) && process.env.ALLOW_REMOTE_REDIS_IN_DEV !== "true") {
    const mode = (process.env.APP_RUNTIME_MODE || process.env.NODE_ENV || "development").toLowerCase();
    if (mode !== "production") {
      console.error(
        "Refusing remote Upstash cleanup from non-production without ALLOW_REMOTE_REDIS_IN_DEV=true",
      );
      process.exit(1);
    }
  }

  const prefixes = onlyPrefix ? [onlyPrefix] : KNOWN_PREFIXES;
  for (const p of prefixes) {
    if (!isAllowedPrefix(p)) {
      console.error(`Refusing unknown prefix: ${p}`);
      process.exit(1);
    }
  }

  const client = new IORedis(url, { maxRetriesPerRequest: 1, enableReadyCheck: true });
  const report: Array<{ key: string; action: "keep" | "delete-candidate" }> = [];

  try {
    for (const prefix of prefixes) {
      for (const queue of LOGICAL_QUEUES) {
        // Obsolete repeatable / meta keys under this prefix+queue
        const patterns = [
          `${prefix}:${queue}:repeat*`,
          `${prefix}:${queue}:stalled-check`,
        ];
        // Only remove repeatables for follow-ups/maintenance (P0 removed those workers).
        // Keep agent-runs operational keys.
        if (queue === "agent-runs" && prefix !== "bull") {
          continue;
        }
        for (const pattern of patterns) {
          let cursor = "0";
          do {
            const [next, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
            cursor = next;
            for (const key of keys) {
              const candidate =
                queue !== "agent-runs" ||
                key.includes(":repeat") ||
                prefix === "bull";
              report.push({
                key,
                action: candidate ? "delete-candidate" : "keep",
              });
            }
          } while (cursor !== "0");
        }
      }
      // Legacy un-namespaced bull:follow-ups / bull:maintenance
      if (prefix === "bull") {
        for (const queue of ["follow-ups", "maintenance"]) {
          let cursor = "0";
          const pattern = `bull:${queue}:*`;
          do {
            const [next, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
            cursor = next;
            for (const key of keys) {
              report.push({ key, action: "delete-candidate" });
            }
          } while (cursor !== "0");
        }
      }
    }

    const toDelete = report.filter((r) => r.action === "delete-candidate");
    console.log(
      JSON.stringify(
        {
          mode: apply ? "APPLY" : "DRY_RUN",
          scanned: report.length,
          deleteCandidates: toDelete.length,
          keys: toDelete.map((r) => r.key).slice(0, 200),
          note:
            "Never FLUSHDB. agent-runs under agentdesk-* prefixes are preserved. Legacy bull:agent-runs:meta may remain unless --apply with bull prefix patterns for follow-ups/maintenance only.",
        },
        null,
        2,
      ),
    );

    if (apply && toDelete.length) {
      for (const { key } of toDelete) {
        await client.del(key);
      }
      console.log(`Deleted ${toDelete.length} keys.`);
    } else if (!apply) {
      console.log("Dry-run only. Re-run with --apply to delete candidates.");
    }
  } finally {
    await client.quit().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
