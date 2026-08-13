#!/usr/bin/env node
/**
 * prisma db push is forbidden. It created schema/migration drift in this repo.
 * Use: npx prisma migrate deploy
 */
console.error(
  [
    "",
    "ERROR: prisma db push is blocked in this project.",
    "It bypasses migration history and caused schema drift.",
    "",
    "Use only:",
    "  npx prisma migrate deploy",
    "",
    "Local empty DB setup:",
    "  npm run db:migrate:deploy && npm run db:seed",
    "",
  ].join("\n"),
);
process.exit(1);
