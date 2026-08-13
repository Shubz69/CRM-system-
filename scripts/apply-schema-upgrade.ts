#!/usr/bin/env node
/**
 * Offline schema-upgrade scripts are forbidden. Use migrate deploy only.
 */
console.error(
  [
    "",
    "ERROR: scripts/apply-schema-upgrade.ts is retired.",
    "Do not patch live schemas outside Prisma migration history.",
    "",
    "Use only:",
    "  npx prisma migrate deploy",
    "",
  ].join("\n"),
);
process.exit(1);
