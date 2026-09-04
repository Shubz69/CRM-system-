import type { AgentAnswerMode } from "@prisma/client";
import {
  answerModeOutputSchema,
  type ActionAnswer,
  type ActionItem,
  type AnswerModeOutput,
  type DeepAnswer,
  type ExecutiveAnswer,
  type QuickAnswer,
} from "./schemas";

export type { AnswerModeOutput, ActionAnswer, DeepAnswer, ExecutiveAnswer, QuickAnswer };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function researchJobIdOf(raw: Record<string, unknown>): string | undefined {
  return str(raw.researchJobId) ?? undefined;
}

function claimTexts(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(raw.claims)) {
    for (const c of raw.claims) {
      if (c && typeof c === "object" && typeof (c as { claim?: unknown }).claim === "string") {
        out.push((c as { claim: string }).claim.trim());
      }
    }
  }
  if (Array.isArray(raw.findings)) {
    for (const f of raw.findings) {
      if (f && typeof f === "object" && typeof (f as { claim?: unknown }).claim === "string") {
        out.push((f as { claim: string }).claim.trim());
      }
    }
  }
  return out.filter(Boolean);
}

function gapsAndRisks(raw: Record<string, unknown>): string[] {
  return [...stringList(raw.gaps), ...stringList(raw.algorithmNotes)].slice(0, 12);
}

function buildQuick(raw: Record<string, unknown>): QuickAnswer {
  const answer =
    str(raw.shortAnswer) ||
    str(raw.summary) ||
    str(raw.answer) ||
    claimTexts(raw)[0] ||
    "No concise answer was available from this run.";
  return {
    mode: "quick",
    answer,
    researchJobId: researchJobIdOf(raw),
  };
}

function buildExecutive(raw: Record<string, unknown>): ExecutiveAnswer {
  const keyFinding =
    str(raw.shortAnswer) || str(raw.summary) || claimTexts(raw)[0] || "Key finding unavailable.";
  const whatMatters = str(raw.summary) || str(raw.brief) || undefined;
  const evidence = claimTexts(raw).slice(0, 8);
  const risks = gapsAndRisks(raw);
  const hooks = stringList(raw.contentHooks);
  const recommendation =
    hooks[0] ||
    (Array.isArray(raw.nextBigThings) &&
    raw.nextBigThings[0] &&
    typeof raw.nextBigThings[0] === "object" &&
    typeof (raw.nextBigThings[0] as { howToRideIt?: unknown }).howToRideIt === "string"
      ? (raw.nextBigThings[0] as { howToRideIt: string }).howToRideIt
      : undefined);

  return {
    mode: "executive",
    keyFinding,
    whatMatters: whatMatters && whatMatters !== keyFinding ? whatMatters : undefined,
    evidence: evidence.length ? evidence : undefined,
    risks: risks.length ? risks : undefined,
    recommendation,
    researchJobId: researchJobIdOf(raw),
  };
}

function buildActionItems(raw: Record<string, unknown>): ActionItem[] {
  const items: ActionItem[] = [];
  const hooks = stringList(raw.contentHooks);
  hooks.forEach((hook, i) => {
    items.push({
      what: hook,
      why: "Suggested from research findings",
      order: i + 1,
      agentDeskCapability: i === 0 ? "draft_content" : i === 1 ? "create_opportunity" : "save_research",
    });
  });

  if (Array.isArray(raw.nextBigThings)) {
    for (const n of raw.nextBigThings) {
      if (!n || typeof n !== "object") continue;
      const pred = str((n as { prediction?: unknown }).prediction);
      const how = str((n as { howToRideIt?: unknown }).howToRideIt);
      if (!pred) continue;
      items.push({
        what: how || pred,
        why: pred,
        order: items.length + 1,
        agentDeskCapability: "create_mission",
        risks: gapsAndRisks(raw).slice(0, 2),
      });
    }
  }

  if (!items.length) {
    const summary = str(raw.shortAnswer) || str(raw.summary) || "Review research and decide next steps";
    items.push(
      {
        what: summary,
        why: "Primary takeaway from research",
        order: 1,
        agentDeskCapability: "create_opportunity",
      },
      {
        what: "Save this research for the team",
        order: 2,
        agentDeskCapability: "save_research",
      },
      {
        what: "Draft follow-up content from these findings",
        order: 3,
        agentDeskCapability: "draft_content",
      },
    );
  }

  return items.slice(0, 8);
}

function buildAction(raw: Record<string, unknown>): ActionAnswer {
  return {
    mode: "action",
    actions: buildActionItems(raw),
    researchJobId: researchJobIdOf(raw),
    summary: str(raw.shortAnswer) || str(raw.summary) || undefined,
  };
}

function buildDeep(raw: Record<string, unknown>): DeepAnswer {
  const findings: DeepAnswer["findings"] = [];
  const sourceClaims = Array.isArray(raw.claims)
    ? raw.claims
    : Array.isArray(raw.findings)
      ? raw.findings
      : [];
  for (const c of sourceClaims) {
    if (!c || typeof c !== "object") continue;
    const claim = str((c as { claim?: unknown }).claim);
    if (!claim) continue;
    const claimKind = str((c as { claimKind?: unknown }).claimKind) ?? undefined;
    const confidenceRaw = (c as { confidence?: unknown }).confidence;
    const confidence =
      typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
        ? Math.max(0, Math.min(1, confidenceRaw))
        : undefined;
    findings.push({
      claim,
      sourceUrl: str((c as { sourceUrl?: unknown }).sourceUrl) ?? undefined,
      evidenceExcerpt: str((c as { evidenceExcerpt?: unknown }).evidenceExcerpt) ?? undefined,
      claimKind,
      confidence,
    });
  }

  const sources: DeepAnswer["sources"] = [];
  if (Array.isArray(raw.sources)) {
    for (const s of raw.sources) {
      if (!s || typeof s !== "object") continue;
      const url = str((s as { url?: unknown }).url);
      if (!url) continue;
      sources.push({
        url,
        title: str((s as { title?: unknown }).title) ?? undefined,
        platform: str((s as { platform?: unknown }).platform) ?? undefined,
      });
    }
  }

  const contradictions = Array.isArray(raw.contradictions)
    ? raw.contradictions
        .map((c) => {
          if (typeof c === "string") return c;
          if (c && typeof c === "object" && typeof (c as { description?: unknown }).description === "string") {
            return (c as { description: string }).description;
          }
          return null;
        })
        .filter((c): c is string => Boolean(c))
    : undefined;

  return {
    mode: "deep",
    executiveSummary: str(raw.shortAnswer) || str(raw.summary) || "Deep report summary unavailable.",
    method: "Gathered available sources, synthesised findings, then cross-checked citations.",
    findings: findings.length ? findings : undefined,
    evidence: claimTexts(raw).slice(0, 20),
    sources: sources.length ? sources : undefined,
    contradictions: contradictions?.length ? contradictions : undefined,
    unknowns: stringList(raw.gaps).length ? stringList(raw.gaps) : undefined,
    caveats: gapsAndRisks(raw).length ? gapsAndRisks(raw) : undefined,
    businessImplications: str(raw.brief) || str(raw.summary) || undefined,
    marketImplications:
      Array.isArray(raw.nextBigThings) && raw.nextBigThings.length
        ? raw.nextBigThings
            .map((n) =>
              n && typeof n === "object" && typeof (n as { prediction?: unknown }).prediction === "string"
                ? (n as { prediction: string }).prediction
                : null,
            )
            .filter((s): s is string => Boolean(s))
            .join(" · ") || undefined
        : undefined,
    recommendations: stringList(raw.contentHooks).length
      ? stringList(raw.contentHooks)
      : undefined,
    nextActions: [
      "Create opportunity",
      "Draft content",
      "Save research",
      "Create mission",
    ],
    researchJobId: researchJobIdOf(raw),
  };
}

/**
 * Shape legacy research/analyst output into a mode-specific finalOutput.
 * Returns null when input is not research-like — leave original shape intact.
 */
export function shapeFinalOutputForMode(
  mode: AgentAnswerMode,
  raw: unknown,
): AnswerModeOutput | null {
  const record = asRecord(raw);
  if (!record) return null;

  const looksResearch =
    typeof record.researchJobId === "string" ||
    Array.isArray(record.claims) ||
    Array.isArray(record.findings) ||
    typeof record.shortAnswer === "string" ||
    typeof record.brief === "string";
  if (!looksResearch && mode) {
    // Still shape if caller insists and we have some text.
    if (!str(record.summary) && !str(record.answer) && !str(record.echo)) return null;
  }

  let shaped: AnswerModeOutput;
  switch (mode) {
    case "QUICK":
      shaped = buildQuick(record);
      break;
    case "EXECUTIVE":
      shaped = buildExecutive(record);
      break;
    case "ACTION":
      shaped = buildAction(record);
      break;
    case "DEEP":
      shaped = buildDeep(record);
      break;
    default:
      return null;
  }

  const parsed = answerModeOutputSchema.safeParse(shaped);
  return parsed.success ? parsed.data : null;
}

/** True when finalOutput already carries a mode discriminator. */
export function isModeShapedOutput(value: unknown): value is AnswerModeOutput {
  return answerModeOutputSchema.safeParse(value).success;
}
