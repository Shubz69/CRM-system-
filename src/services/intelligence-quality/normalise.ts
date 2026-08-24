/**
 * Phase 14F — claim text normalisation.
 * Deterministic only — never LLM-invented keys.
 */

import { createHash } from "node:crypto";

export function normaliseClaimText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}\s\-_%./]/gu, "")
    .trim();
}

/** Stable org-scoped dedupe key for IntelligenceClaim.normalisedKey */
export function claimNormalisedKey(text: string, entityHint?: string | null): string {
  const base = `${normaliseClaimText(text)}|${(entityHint ?? "").trim().toLowerCase()}`;
  return createHash("sha256").update(base).digest("hex").slice(0, 40);
}

export function lineageKey(input: {
  providerKey?: string | null;
  host?: string | null;
  accountRef?: string | null;
}): string {
  const host = (input.host ?? "").toLowerCase().replace(/^www\./, "");
  return createHash("sha256")
    .update(`${input.providerKey ?? ""}|${host}|${input.accountRef ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

export function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
