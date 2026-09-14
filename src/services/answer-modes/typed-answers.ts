/**
 * Shape any Ask payload into the four customer-facing answer types.
 * Never invents source URLs. Never returns blank section bodies.
 */
import {
  ASK_TYPED_ANSWER_LABELS,
  ASK_TYPED_ANSWER_TYPES,
  type AskTypedAnswerType,
} from "@/lib/ask-result-ui";

export const ASK_VIDEO_NOT_CONFIGURED_CODE = "AUTH_REQUIRED" as const;
export const ASK_VIDEO_NOT_CONFIGURED_REASON = "VIDEO_PROVIDER_NOT_CONFIGURED" as const;

export type AskTypedSection = {
  type: AskTypedAnswerType;
  title: string;
  body: string;
  bullets?: string[];
};

export type AskTypedAnswers = {
  strategy: AskTypedSection;
  scripts: AskTypedSection;
  postingPlan: AskTypedSection;
  monetization: AskTypedSection;
};

export type AskVideoExampleStatus = "brief_only" | "queued" | "generated" | "not_configured";

export type AskVideoExample = {
  title: string;
  hook: string;
  shotList: string[];
  lengthSeconds: number;
  platform: "instagram" | "linkedin" | "tiktok" | "youtube" | "generic";
  status: AskVideoExampleStatus;
  code?: typeof ASK_VIDEO_NOT_CONFIGURED_CODE;
  reason?: typeof ASK_VIDEO_NOT_CONFIGURED_REASON;
  userFacingMessage?: string;
  assetId?: string;
  url?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
}

/** Drop raw URLs from customer-facing copy — evidence stays internal. */
export function stripUrlsForAskDisplay(text: string): string {
  return text
    .replace(/https?:\/\/[^\s)]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function claimTexts(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  const pushClaim = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const claim = str((value as { claim?: unknown }).claim);
    if (claim) out.push(stripUrlsForAskDisplay(claim));
  };
  if (Array.isArray(raw.claims)) raw.claims.forEach(pushClaim);
  if (Array.isArray(raw.findings)) raw.findings.forEach(pushClaim);
  return out.filter(Boolean);
}

function operatorLines(raw: Record<string, unknown>, key: string): string[] {
  const sections = asRecord(raw.operatorSections);
  if (!sections) return [];
  return stringList(sections[key]).map(stripUrlsForAskDisplay);
}

function uniqueLines(lines: string[], max = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const cleaned = stripUrlsForAskDisplay(line);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

function joinBody(lead: string | null, bullets: string[], fallback: string): { body: string; bullets?: string[] } {
  const cleanedLead = lead ? stripUrlsForAskDisplay(lead) : "";
  const cleanedBullets = uniqueLines(bullets);
  const body = cleanedLead || cleanedBullets[0] || fallback;
  return {
    body,
    ...(cleanedBullets.length ? { bullets: cleanedBullets } : {}),
  };
}

function section(
  type: AskTypedAnswerType,
  lead: string | null,
  bullets: string[],
  fallback: string,
): AskTypedSection {
  const packed = joinBody(lead, bullets, fallback);
  return {
    type,
    title: ASK_TYPED_ANSWER_LABELS[type],
    body: packed.body,
    ...(packed.bullets ? { bullets: packed.bullets } : {}),
  };
}

function topicOf(raw: Record<string, unknown>, request?: string | null): string {
  return (
    str(raw.topic) ||
    (request || "").replace(/\s+/g, " ").trim().slice(0, 180) ||
    "this request"
  );
}

export function looksLikeContentOrGrowthAsk(text: string | null | undefined): boolean {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return false;
  return /\b(instagram|linkedin|tiktok|youtube|reel|reels|short[- ]form|posting|caption|hook|followers?|personal brand|content (strategy|plan|calendar)|grow (on|my|an)?\s*(ig|insta|linkedin|tiktok)?|monetiz|fame|thought leadership|carousel)\b/i.test(
    t,
  );
}

function emptyFallback(topic: string): AskTypedAnswers {
  const base = `I could not finish a full answer for ${topic} in time. Nothing here was invented — try the same Ask again.`;
  return {
    strategy: section("strategy", null, [], `${base} Start with one clear outcome and the next action you can take this week.`),
    scripts: section("scripts", null, [], `${base} Draft a one-line hook and two talking points once you have a concrete offer.`),
    postingPlan: section("posting_plan", null, [], `${base} Use a simple cadence: 3–5 posts a week, one format you can repeat.`),
    monetization: section("monetization", null, [], `${base} Convert attention with a clear offer, a DM/reply path, and a paid next step.`),
  };
}

/**
 * Deterministic 4-section answers from whatever the run already gathered.
 * Safe to call on the client for legacy payloads that predate typedAnswers.
 */
export function buildTypedAnswers(raw: unknown, request?: string | null): AskTypedAnswers {
  const record = asRecord(raw);
  const topic = topicOf(record ?? {}, request);
  if (!record) return emptyFallback(topic);

  const existing = asRecord(record.typedAnswers);
  if (existing) {
    const fromExisting = typedAnswersFromPartial(existing, topic);
    if (fromExisting) return fromExisting;
  }

  const claims = claimTexts(record);
  const hooks = stringList(record.contentHooks).map(stripUrlsForAskDisplay);
  const algorithmNotes = stringList(record.algorithmNotes).map(stripUrlsForAskDisplay);
  const gaps = stringList(record.gaps).map(stripUrlsForAskDisplay);
  const nextHow: string[] = [];
  const nextPred: string[] = [];
  if (Array.isArray(record.nextBigThings)) {
    for (const n of record.nextBigThings) {
      if (!n || typeof n !== "object") continue;
      const pred = str((n as { prediction?: unknown }).prediction);
      const how = str((n as { howToRideIt?: unknown }).howToRideIt);
      if (pred) nextPred.push(stripUrlsForAskDisplay(pred));
      if (how) nextHow.push(stripUrlsForAskDisplay(how));
    }
  }

  const summary =
    str(record.summary) ||
    str(record.shortAnswer) ||
    str(record.answer) ||
    str(record.keyFinding) ||
    str(record.executiveSummary) ||
    str(record.brief);
  const recommendation = str(record.recommendation);
  const implications = str(record.businessImplications) || str(record.marketImplications);

  const crm = record.source === "internal_crm";
  const priorities = operatorLines(record, "topPriorities");
  const attention = operatorLines(record, "needsAttention");
  const sales = operatorLines(record, "sales");
  const pipeline = operatorLines(record, "pipelineRisk");
  const content = operatorLines(record, "content");
  const automation = operatorLines(record, "automation");
  const goals = operatorLines(record, "goalsKpi");

  const contentAsk = looksLikeContentOrGrowthAsk(`${request || ""} ${topic} ${summary || ""}`);

  const strategyLead =
    recommendation ||
    (crm ? priorities[0] : null) ||
    summary ||
    claims[0] ||
    nextPred[0];
  const strategyBullets = crm
    ? uniqueLines([...priorities, ...attention, ...claims], 6)
    : uniqueLines([...claims.slice(0, 4), ...nextPred, ...gaps.slice(0, 2)], 6);

  const scriptBullets = crm
    ? uniqueLines([...sales, ...attention, ...hooks], 6)
    : uniqueLines(
        [
          ...hooks,
          ...claims.slice(0, 4).map((c) => `Talking point: ${c}`),
          contentAsk ? `Hook: Stop scrolling — ${topic}` : null,
        ].filter((v): v is string => Boolean(v)),
        6,
      );
  const scriptsLead = hooks[0] || scriptBullets[0] || null;

  const postingBullets = crm
    ? uniqueLines(
        [
          ...content,
          ...automation,
          "Follow up stalled conversations before publishing more volume.",
        ],
        6,
      )
    : uniqueLines(
        [
          ...algorithmNotes,
          contentAsk
            ? "Cadence: 4–6 short-form posts a week (Reels / native video) plus 3 LinkedIn posts."
            : "Use findings in the next 5 outreach or follow-up touches this week — this is not a publishing calendar.",
          contentAsk
            ? "Formats: 15–30s hook-led video, carousel proof, and one talking-head story."
            : "Batch the work: one research block, then send or brief — do not wait on a perfect report.",
          contentAsk ? "Timing: post when your audience is already scrolling (weekday mornings + early evening)." : null,
        ].filter((v): v is string => Boolean(v)),
        6,
      );

  const moneyBullets = crm
    ? uniqueLines([...pipeline, ...sales, ...goals, implications ? [implications] : []].flat(), 6)
    : uniqueLines(
        [
          ...nextHow,
          implications,
          contentAsk
            ? "Convert attention: pin a clear offer, reply to every warm comment/DM, and move chats to a booked call."
            : "Turn the strongest finding into a paid next step (quote, booking, or retainer conversation).",
          "Fame without a path to money is optional — pair every public post with a private follow-up.",
        ].filter((v): v is string => Boolean(v)),
        6,
      );

  return {
    strategy: section(
      "strategy",
      strategyLead,
      strategyBullets,
      `Decide the next move on ${topic}: pick one outcome, one audience, and one action you can finish this week.`,
    ),
    scripts: section(
      "scripts",
      scriptsLead,
      scriptBullets,
      `Hook: The honest take on ${topic}. Then 2–3 talking points from what you actually know — do not invent stats.`,
    ),
    postingPlan: section(
      "posting_plan",
      postingBullets[0] || null,
      postingBullets,
      contentAsk
        ? "Post 4–6 short videos a week, one proof carousel, and one longer LinkedIn post. Repeat the winning hook."
        : `No publishing calendar was required for ${topic}. Use the findings in outreach this week instead.`,
    ),
    monetization: section(
      "monetization",
      moneyBullets[0] || null,
      moneyBullets,
      `Get paid by turning attention on ${topic} into a booked conversation, a quote, or a simple offer in the bio/DM.`,
    ),
  };
}

function typedAnswersFromPartial(
  existing: Record<string, unknown>,
  topic: string,
): AskTypedAnswers | null {
  const pick = (key: string, type: AskTypedAnswerType): AskTypedSection | null => {
    const rec = asRecord(existing[key]);
    if (!rec) return null;
    const body = str(rec.body);
    if (!body) return null;
    return {
      type,
      title: str(rec.title) || ASK_TYPED_ANSWER_LABELS[type],
      body: stripUrlsForAskDisplay(body),
      bullets: stringList(rec.bullets).map(stripUrlsForAskDisplay),
    };
  };
  const strategy = pick("strategy", "strategy");
  const scripts = pick("scripts", "scripts");
  const postingPlan = pick("postingPlan", "posting_plan") || pick("posting_plan", "posting_plan");
  const monetization = pick("monetization", "monetization");
  if (!strategy || !scripts || !postingPlan || !monetization) return null;
  const fallback = emptyFallback(topic);
  return {
    strategy: strategy.body ? strategy : fallback.strategy,
    scripts: scripts.body ? scripts : fallback.scripts,
    postingPlan: postingPlan.body ? postingPlan : fallback.postingPlan,
    monetization: monetization.body ? monetization : fallback.monetization,
  };
}

export function videoNotConfiguredMessage(): string {
  return "Example AI videos are not configured. Set VIDEO_PROVIDER and the matching API key to generate them. The briefs below are ready when that is set — nothing was faked.";
}

export function buildVideoExamples(input: {
  raw?: unknown;
  request?: string | null;
  typedAnswers?: AskTypedAnswers;
  videoConfigured?: boolean;
}): AskVideoExample[] {
  const record = asRecord(input.raw) ?? {};
  const topic = topicOf(record, input.request);
  const haystack = `${input.request || ""} ${topic} ${str(record.summary) || ""}`;
  if (!looksLikeContentOrGrowthAsk(haystack) && record.source === "internal_crm") {
    return [];
  }
  if (!looksLikeContentOrGrowthAsk(haystack) && !looksLikeContentOrGrowthAsk(topic)) {
    return [];
  }

  const answers = input.typedAnswers ?? buildTypedAnswers(record, input.request);
  const hook =
    answers.scripts.bullets?.[0] ||
    answers.scripts.body.split("\n")[0] ||
    `Stop scrolling — ${topic}`;
  const strategyLine = answers.strategy.bullets?.[0] || answers.strategy.body;
  const moneyLine = answers.monetization.bullets?.[0] || answers.monetization.body;
  const configured = Boolean(input.videoConfigured);
  const status: AskVideoExampleStatus = configured ? "brief_only" : "not_configured";
  const notConfigured = configured
    ? {}
    : {
        code: ASK_VIDEO_NOT_CONFIGURED_CODE,
        reason: ASK_VIDEO_NOT_CONFIGURED_REASON,
        userFacingMessage: videoNotConfiguredMessage(),
      };

  const ig: AskVideoExample = {
    title: `Instagram Reel — ${topic}`.slice(0, 120),
    hook: stripUrlsForAskDisplay(hook).slice(0, 220),
    shotList: uniqueLines(
      [
        "0–3s: face or bold text hook on screen",
        `3–8s: one proof line (${strategyLine})`,
        "8–15s: three rapid cuts of the method / examples",
        "15–25s: CTA to follow + DM the keyword",
      ],
      6,
    ),
    lengthSeconds: 25,
    platform: "instagram",
    status,
    ...notConfigured,
  };
  const li: AskVideoExample = {
    title: `LinkedIn native video — ${topic}`.slice(0, 120),
    hook: stripUrlsForAskDisplay(`Most people do ${topic} backwards.`).slice(0, 220),
    shotList: uniqueLines(
      [
        "Talking-head cold open with the contrarian hook",
        `One story or proof point (${strategyLine})`,
        `How this turns into money or booked calls (${moneyLine})`,
        "End card: comment 'PLAYBOOK' or book a call",
      ],
      6,
    ),
    lengthSeconds: 45,
    platform: "linkedin",
    status,
    ...notConfigured,
  };
  return [ig, li];
}

export function looksLikeTypedAskPayload(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (asRecord(record.typedAnswers)) return true;
  if (typeof record.mode === "string") return true;
  if (typeof record.researchJobId === "string") return true;
  if (record.source === "internal_crm") return true;
  if (Array.isArray(record.findings) && record.findings.length > 0) return true;
  if (Array.isArray(record.sources) && record.sources.length > 0) return true;
  if (Array.isArray(record.claims) && record.claims.length > 0) return true;
  if (str(record.summary) || str(record.answer) || str(record.shortAnswer) || str(record.brief)) {
    return true;
  }
  if (str(record.keyFinding) || str(record.executiveSummary)) return true;
  return false;
}

export function hasCompleteTypedAnswers(value: unknown): boolean {
  if (!looksLikeTypedAskPayload(value)) return false;
  const answers = resolveTypedAnswers(value);
  return ASK_TYPED_ANSWER_TYPES.every((type) => {
    const sectionForType =
      type === "strategy"
        ? answers.strategy
        : type === "scripts"
          ? answers.scripts
          : type === "posting_plan"
            ? answers.postingPlan
            : answers.monetization;
    return Boolean(sectionForType?.body?.trim());
  });
}

export function resolveTypedAnswers(value: unknown, request?: string | null): AskTypedAnswers {
  const record = asRecord(value);
  if (record) {
    const existing = typedAnswersFromPartial(asRecord(record.typedAnswers) ?? record, topicOf(record, request));
    if (existing) return existing;
  }
  return buildTypedAnswers(value, request);
}

export function resolveVideoExamples(value: unknown, request?: string | null): AskVideoExample[] {
  const record = asRecord(value);
  if (record && Array.isArray(record.videoExamples)) {
    const parsed: AskVideoExample[] = [];
    for (const item of record.videoExamples) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const title = str(rec.title);
      const hook = str(rec.hook);
      if (!title || !hook) continue;
      const shotList = stringList(rec.shotList);
      const lengthSeconds =
        typeof rec.lengthSeconds === "number" && Number.isFinite(rec.lengthSeconds)
          ? rec.lengthSeconds
          : 30;
      const platformRaw = str(rec.platform) || "generic";
      const platform =
        platformRaw === "instagram" ||
        platformRaw === "linkedin" ||
        platformRaw === "tiktok" ||
        platformRaw === "youtube"
          ? platformRaw
          : "generic";
      const statusRaw = str(rec.status) || "not_configured";
      const status: AskVideoExampleStatus =
        statusRaw === "brief_only" ||
        statusRaw === "queued" ||
        statusRaw === "generated" ||
        statusRaw === "not_configured"
          ? statusRaw
          : "not_configured";
      parsed.push({
        title,
        hook,
        shotList: shotList.length ? shotList : ["Hook", "Proof", "CTA"],
        lengthSeconds,
        platform,
        status,
        code: rec.code === ASK_VIDEO_NOT_CONFIGURED_CODE ? ASK_VIDEO_NOT_CONFIGURED_CODE : undefined,
        reason:
          rec.reason === ASK_VIDEO_NOT_CONFIGURED_REASON ? ASK_VIDEO_NOT_CONFIGURED_REASON : undefined,
        userFacingMessage: str(rec.userFacingMessage) ?? undefined,
        assetId: str(rec.assetId) ?? undefined,
        url: str(rec.url) ?? undefined,
      });
    }
    if (parsed.length) return parsed;
  }
  return buildVideoExamples({ raw: value, request });
}
