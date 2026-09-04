/**
 * Canonical grounded claims for Research Quality scoring.
 * Prefer verified findings/claims already grounded to collected sources.
 * Analyst/narrative enrichment may consume this set — it must not be RQS's sole source.
 */

export type CanonicalGroundedClaim = {
  id: string;
  text: string;
  sourceUrl?: string;
  evidenceExcerpt?: string;
  claimKind?: string;
  /** 0–1 when known; omit when unknown (never invent 1.0). */
  confidence?: number;
  supportStatus: "grounded" | "partial" | "unlinked";
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeUrlKey(u: string): string {
  try {
    const parsed = new URL(u.trim());
    parsed.hash = "";
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return u.trim().replace(/\/+$/, "");
  }
}

function deriveConfidence(input: {
  confidence?: number;
  claimKind?: string;
  evidenceExcerpt?: string;
  supportStatus: CanonicalGroundedClaim["supportStatus"];
}): number | undefined {
  if (typeof input.confidence === "number" && Number.isFinite(input.confidence)) {
    return Math.max(0, Math.min(1, input.confidence));
  }
  if (input.supportStatus === "unlinked") return undefined;
  // Neutral signals only — never invent high confidence.
  let base = 0.55;
  if (input.evidenceExcerpt && input.evidenceExcerpt.trim().length >= 12) base = 0.7;
  if (input.claimKind === "OFFICIAL") base = Math.max(base, 0.75);
  if (input.claimKind === "INFERENCE" || input.claimKind === "SECONDARY") {
    base = Math.min(base, 0.6);
  }
  if (input.supportStatus === "partial") base = Math.min(base, 0.55);
  return base;
}

function collectRawRows(output: Record<string, unknown>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  // Prefer findings (post Deep-shape) then claims (analyst / research intermediate).
  for (const key of ["findings", "claims"] as const) {
    const arr = output[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const rec = asRecord(item);
      if (rec) rows.push(rec);
    }
  }
  return rows;
}

/**
 * Build the canonical grounded-claim set from research/analyst/deep-shaped output.
 * Dedupes by text+sourceUrl. Does not invent claims.
 */
export function extractCanonicalGroundedClaims(
  output: unknown,
  options?: { allowedSourceUrls?: string[] },
): CanonicalGroundedClaim[] {
  const obj = asRecord(output);
  if (!obj) return [];

  const allowed = new Set((options?.allowedSourceUrls || []).filter(Boolean));
  if (Array.isArray(obj.sources)) {
    for (const s of obj.sources) {
      const rec = asRecord(s);
      const url = rec ? str(rec.url) : null;
      if (url) allowed.add(url);
    }
  }
  const allowedNorm = new Set([...allowed].map(normalizeUrlKey));
  const urlAllowed = (url: string) =>
    allowed.size === 0 || allowed.has(url) || allowedNorm.has(normalizeUrlKey(url));

  const seen = new Set<string>();
  const out: CanonicalGroundedClaim[] = [];

  for (const row of collectRawRows(obj)) {
    const text = str(row.claim);
    if (!text) continue;
    const sourceUrl = str(row.sourceUrl) ?? undefined;
    const evidenceExcerpt = str(row.evidenceExcerpt) ?? undefined;
    const claimKind = str(row.claimKind) ?? undefined;
    const confidenceRaw =
      typeof row.confidence === "number" && Number.isFinite(row.confidence)
        ? row.confidence
        : undefined;

    let supportStatus: CanonicalGroundedClaim["supportStatus"] = "unlinked";
    if (sourceUrl && urlAllowed(sourceUrl)) {
      supportStatus =
        evidenceExcerpt && evidenceExcerpt.length >= 12 ? "grounded" : "partial";
    } else if (sourceUrl && allowed.size === 0) {
      // Sources not yet attached on the object — treat URL presence as partial.
      supportStatus = evidenceExcerpt ? "grounded" : "partial";
    }

    const key = `${text.toLowerCase()}|${sourceUrl ? normalizeUrlKey(sourceUrl) : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const confidence = deriveConfidence({
      confidence: confidenceRaw,
      claimKind,
      evidenceExcerpt,
      supportStatus,
    });

    out.push({
      id: `gc_${out.length + 1}`,
      text,
      sourceUrl,
      evidenceExcerpt,
      claimKind,
      confidence,
      supportStatus,
    });
  }

  return out;
}

/** Map canonical claims into ScoreResearchInput.claims shape. */
export function toScoreResearchClaims(claims: CanonicalGroundedClaim[]) {
  return claims.map((c) => ({
    claim: c.text,
    sourceUrl: c.sourceUrl,
    evidenceExcerpt: c.evidenceExcerpt,
    claimKind: c.claimKind,
    confidence: c.confidence,
  }));
}

export function countLinkedGroundedClaims(claims: CanonicalGroundedClaim[]): number {
  return claims.filter((c) => c.supportStatus === "grounded" || c.supportStatus === "partial")
    .length;
}
