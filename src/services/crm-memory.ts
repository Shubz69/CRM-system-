/**
 * Structured CRM memory for leads — Claude extracts; we merge carefully.
 * High-confidence manually confirmed fields are not overwritten by weaker AI inference.
 */

export type CrmMemoryField = {
  value: string | string[] | null;
  source: "AI" | "HUMAN" | "INTEGRATION";
  confidence: number;
  messageId?: string | null;
  updatedAt: string;
};

export type CrmMemory = Record<string, CrmMemoryField | undefined> & {
  updatedAt?: string;
  updatedBy?: string;
};

const PROTECTED_SOURCES = new Set(["HUMAN"]);

export function readCrmMemory(metadata: unknown): CrmMemory {
  if (!metadata || typeof metadata !== "object") return {};
  const meta = metadata as Record<string, unknown>;
  if (meta.crmMemory && typeof meta.crmMemory === "object") {
    return meta.crmMemory as CrmMemory;
  }
  return {};
}

export function mergeCrmMemory(input: {
  existing: CrmMemory;
  updates?: Record<string, string | string[] | null | undefined> | null;
  confidence: number;
  messageId?: string | null;
  source?: "AI" | "HUMAN" | "INTEGRATION";
}): CrmMemory {
  const source = input.source || "AI";
  const next: CrmMemory = { ...input.existing };
  const updates = input.updates || {};

  for (const [key, raw] of Object.entries(updates)) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw === "string" && !raw.trim()) continue;
    if (Array.isArray(raw) && raw.length === 0) continue;

    const prev = next[key];
    if (
      prev &&
      typeof prev === "object" &&
      "source" in prev &&
      PROTECTED_SOURCES.has(String(prev.source)) &&
      source === "AI"
    ) {
      // Do not overwrite human-confirmed fields with AI inference
      continue;
    }
    if (
      prev &&
      typeof prev === "object" &&
      "confidence" in prev &&
      typeof prev.confidence === "number" &&
      source === "AI" &&
      input.confidence < prev.confidence
    ) {
      continue;
    }

    next[key] = {
      value: raw,
      source,
      confidence: input.confidence,
      messageId: input.messageId ?? null,
      updatedAt: new Date().toISOString(),
    };
  }

  next.updatedAt = new Date().toISOString();
  next.updatedBy = source;
  return next;
}

/** Flatten memory to simple values for Claude prompt injection */
export function flattenCrmMemory(memory: CrmMemory): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(memory)) {
    if (!field || typeof field !== "object" || !("value" in field)) continue;
    out[key] = (field as CrmMemoryField).value;
  }
  return out;
}
