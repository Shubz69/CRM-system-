import { SocialActionMode, SocialNetworkKind, SocialProspectStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { linkedInV1ActionSurface } from "@/services/social-prospecting/linkedin-native";
import type { SocialNetworkId, SocialProfileIdentity } from "@/services/social-prospecting/types";
import {
  universalOutreachSurface,
  type OutreachActionSurface,
  type SocialMessagingNetwork,
} from "@/services/social-prospecting/provider-router";

export type OutreachDrafts = {
  connectionNote: string;
  followUpOne: string;
  followUpTwo: string;
  instagramMessage: string;
  instagramFollowUp: string;
  genericSocialOutreach: string;
  emailDraft?: string;
};

/** The sender's side of the note: who we are, what we offer, who for, and how we sound. */
export type OutreachBusinessContext = {
  businessName: string | null;
  offerSummary: string | null;
  audience: string | null;
  brandTone: string | null;
};

const PLACEHOLDER_PRODUCT = /^primary offering$/i;
const PLACEHOLDER_AUDIENCE = /^primary audience$/i;

function oneLine(text: string | null | undefined, max: number): string | null {
  const clean = (text ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  if (!clean) return null;
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/**
 * Load the workspace's business profile (as captured in onboarding / Business Context) so
 * outreach drafts speak for this business instead of a generic "AI operations" pitch.
 * Every lookup is best-effort: missing pieces just fall back to neutral wording.
 */
export async function loadOutreachBusinessContext(
  organisationId: string,
): Promise<OutreachBusinessContext> {
  try {
    return await readOutreachBusinessContext(organisationId);
  } catch {
    return { businessName: null, offerSummary: null, audience: null, brandTone: null };
  }
}

async function readOutreachBusinessContext(organisationId: string): Promise<OutreachBusinessContext> {
  const [org, whatWeDo, primaryOffering, products, audiences, agentConfig] = await Promise.all([
    prisma.organisation
      .findUnique({ where: { id: organisationId }, select: { name: true } })
      .catch(() => null),
    prisma.businessClaim
      .findFirst({
        where: {
          organisationId,
          predicate: "what_we_do",
          status: { in: ["CONFIRMED", "OBSERVED", "INFERRED"] },
        },
        orderBy: { observedAt: "desc" },
        select: { valueText: true },
      })
      .catch(() => null),
    prisma.productOffering
      .findFirst({
        where: { organisationId, name: "Primary offering" },
        select: { description: true },
      })
      .catch(() => null),
    prisma.productOffering
      .findMany({
        where: { organisationId, status: "ACTIVE" },
        orderBy: { updatedAt: "desc" },
        take: 3,
        select: { name: true, description: true, targetAudience: true },
      })
      .catch(() => []),
    prisma.audienceSegment
      .findMany({
        where: { organisationId },
        orderBy: { updatedAt: "desc" },
        take: 2,
        select: { name: true, description: true },
      })
      .catch(() => []),
    prisma.agentConfiguration
      .findFirst({
        where: { organisationId, isActive: true, isDraft: false },
        orderBy: { updatedAt: "desc" },
        select: { brandTone: true },
      })
      .catch(() => null),
  ]);

  const productRows = products ?? [];
  // One entry per product name — a profile listing "Balayage colour" twice used to produce
  // "a short note on balayage colour and Balayage colour".
  const seenProductNames = new Set<string>();
  const namedProducts = productRows.filter((p) => {
    if (!p.name || PLACEHOLDER_PRODUCT.test(p.name)) return false;
    const key = p.name.trim().toLowerCase();
    if (seenProductNames.has(key)) return false;
    seenProductNames.add(key);
    return true;
  });
  // "Primary offering" is what Business Context edits; the onboarding claim is the fallback.
  const offerSummary =
    oneLine(primaryOffering?.description, 120) ||
    oneLine(whatWeDo?.valueText, 120) ||
    oneLine(
      namedProducts
        .slice(0, 2)
        .map((p) => p.name.trim())
        .join(" and "),
      120,
    );

  const audience =
    oneLine(
      (audiences ?? [])
        .map((a) => (PLACEHOLDER_AUDIENCE.test(a.name) ? a.description : a.name))
        .find(Boolean),
      80,
    ) || oneLine(productRows.map((p) => p.targetAudience).find(Boolean), 80);

  return {
    businessName: oneLine(org?.name, 60),
    offerSummary,
    audience,
    brandTone: oneLine(agentConfig?.brandTone, 120),
  };
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/**
 * End a sentence with one full stop: evidence quotes often end in their own punctuation,
 * which used to give "…this autumn.. I'm with Glow Salon".
 */
export function withFullStop(text: string): string {
  const trimmed = text.trimEnd();
  return /[.!?…]["”’)\]]*$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Generate personalised outreach copy grounded only in provided evidence.
 * Never invents that the user saw a post/event without evidence.
 * The sender side (business name, offer, audience, tone) comes from the workspace profile.
 */
export function generateOutreachDrafts(input: {
  personName?: string | null;
  companyName?: string | null;
  role?: string | null;
  location?: string | null;
  sector?: string | null;
  reasonSelected?: string | null;
  evidenceExcerpts?: string[];
  offerSummary?: string | null;
  brandTone?: string | null;
  /** The workspace's business name ("I'm with …"). */
  businessName?: string | null;
  /** Who the business serves ("we work with …"). */
  audience?: string | null;
  email?: string | null;
  /** Only set when evidence proves a specific public post/activity */
  observedPostExcerpt?: string | null;
  /** 0–1; weak evidence → safer, less-specific copy */
  evidenceConfidence?: number | null;
}): OutreachDrafts {
  const name = input.personName?.split(" ")[0] || "there";
  const conf = input.evidenceConfidence ?? 0.6;
  const strong = conf >= 0.65;
  const company = strong && input.companyName ? input.companyName : "your work";
  const role = strong && input.role ? ` as ${input.role}` : "";
  const locationBit = strong && input.location ? ` in ${input.location}` : "";
  const sectorBit = strong && input.sector ? ` (${input.sector})` : "";

  const evidenceBit = strong
    ? (input.evidenceExcerpts || []).find((e) => e.trim().length > 12)?.trim()
    : undefined;
  const postBit = strong ? input.observedPostExcerpt?.trim() : undefined;

  let grounded: string;
  if (postBit) {
    grounded = `I saw your recent note: “${postBit.slice(0, 100)}${postBit.length > 100 ? "…" : ""}”`;
  } else if (evidenceBit) {
    grounded = `From public research: ${evidenceBit.slice(0, 120)}${evidenceBit.length > 120 ? "…" : ""}`;
  } else if (strong && input.reasonSelected) {
    grounded = `I've been researching ${company}${role}${locationBit}${sectorBit}`;
  } else if (strong && input.companyName) {
    grounded = `I've been looking at ${input.companyName}${locationBit}`;
  } else {
    // Graceful degradation — never fabricate specificity
    grounded = `I came across your profile and thought it was worth a short note`;
  }

  // Never fall back to someone else's pitch: without a profile the copy stays neutral.
  const offerRaw = oneLine(input.offerSummary, 120);
  // "We make wedding cakes" is a sentence about us; "AI ops for founders" is a topic.
  const offerSentence = offerRaw && /^(we|i|our|my)\b/i.test(offerRaw) ? `${offerRaw}.` : "";
  const offerTopic = offerRaw && !offerSentence ? lowerFirst(offerRaw) : null;
  const businessName = oneLine(input.businessName, 60);
  const audience = oneLine(input.audience, 80);
  const tone = (input.brandTone || "professional, concise").toLowerCase();
  const casual = /casual|friendly|relaxed|playful|informal|warm/.test(tone);
  const formal = !casual && /formal|corporate/.test(tone);
  const greeting = casual ? "Hey" : "Hi";
  const signOff = casual ? "Cheers" : formal ? "Kind regards" : "Best regards";

  const intro = businessName
    ? `I'm with ${businessName}${audience ? ` — we work with ${lowerFirst(audience)}` : ""}.`
    : audience
      ? `We work with ${lowerFirst(audience)}.`
      : "";
  const whoWeAre = [intro, offerSentence].filter(Boolean).join(" ");
  const whoWeAreShort = businessName ? `I'm with ${businessName}.` : "";

  // LinkedIn connection notes are capped (~300 chars): drop optional detail before truncating.
  const opener = `${greeting} ${name} — ${withFullStop(grounded)}`;
  const connectionClose = `Would be glad to connect and share a short note on ${offerTopic ?? "what we do"}.`;
  const connectionNote = (
    [
      [opener, whoWeAre, connectionClose],
      [opener, intro, connectionClose],
      [opener, whoWeAreShort, connectionClose],
      [opener, connectionClose],
    ]
      .map((parts) => parts.filter(Boolean).join(" "))
      .find((note) => note.length <= 280) ?? `${opener} ${connectionClose}`
  ).slice(0, 280);

  const followUpOne = [
    `${greeting} ${name}, thanks for connecting.`,
    strong && input.companyName && offerTopic
      ? `Curious whether ${input.companyName} is exploring ${offerTopic}? Happy to share a 2-minute overview if useful.`
      : `Curious whether this is on your radar — happy to share a 2-minute overview if useful.`,
  ].join(" ");

  const followUpTwo = [
    `${greeting} ${name} — circling back once.`,
    `If timing is off, no worries — happy to share a brief resource whenever it helps.`,
  ].join(" ");

  const instagramMessage = [
    opener,
    whoWeAre,
    casual
      ? offerTopic
        ? `Thought ${offerTopic} might be relevant.`
        : `Thought this might be relevant.`
      : offerTopic
        ? `Sharing a concise idea on ${offerTopic} that may help.`
        : `Sharing a concise idea that may help.`,
  ]
    .filter(Boolean)
    .join(" ");

  const instagramFollowUp = `${greeting} ${name}, just following up in case my earlier note was buried. Happy to keep it short.`;

  const genericSocialOutreach = [
    opener,
    whoWeAre,
    `If useful, I can share a brief note on ${offerTopic ?? "what we do"}.`,
  ]
    .filter(Boolean)
    .join(" ");

  const emailDraft = input.email
    ? [
        `Subject: Quick idea${strong && input.companyName ? ` for ${input.companyName}` : ""}`,
        "",
        `${greeting} ${name},`,
        "",
        withFullStop(grounded),
        ...(whoWeAre ? ["", whoWeAre] : []),
        "",
        offerTopic
          ? `If helpful, I can share how we approach ${offerTopic}.`
          : "If helpful, I can share a little more about what we do.",
        "",
        businessName ? `${signOff},\n${businessName}` : signOff,
      ].join("\n")
    : undefined;

  return {
    connectionNote,
    followUpOne,
    followUpTwo,
    instagramMessage,
    instagramFollowUp,
    genericSocialOutreach,
    emailDraft,
  };
}

function toPrismaNetwork(network: SocialNetworkId): SocialNetworkKind {
  switch (network) {
    case "LINKEDIN":
      return SocialNetworkKind.LINKEDIN;
    case "INSTAGRAM":
      return SocialNetworkKind.INSTAGRAM;
    case "X":
      return SocialNetworkKind.X;
    case "TIKTOK":
      return SocialNetworkKind.TIKTOK;
    case "YOUTUBE":
      return SocialNetworkKind.YOUTUBE;
    case "FACEBOOK":
      return SocialNetworkKind.FACEBOOK;
    case "THREADS":
      return SocialNetworkKind.THREADS;
    default:
      return SocialNetworkKind.OTHER;
  }
}

function showableIdentities(raw: unknown): SocialProfileIdentity[] {
  if (!Array.isArray(raw)) return [];
  return (raw as SocialProfileIdentity[]).filter(
    (i) => i && (i.verificationState === "VERIFIED" || i.verificationState === "LIKELY") && i.canonicalProfileUrl,
  );
}

export function buildActionSurfacesForProspect(input: {
  linkedinUrl?: string | null;
  instagramUrl?: string | null;
  socialIdentities?: unknown;
}): OutreachActionSurface[] {
  const surfaces: OutreachActionSurface[] = [];
  const ids = showableIdentities(input.socialIdentities);
  const networks = new Set(ids.map((i) => i.network));

  if (input.linkedinUrl || networks.has("LINKEDIN")) {
    surfaces.push(universalOutreachSurface("LINKEDIN"));
  }
  if (input.instagramUrl || networks.has("INSTAGRAM")) {
    surfaces.push(universalOutreachSurface("INSTAGRAM"));
  }
  for (const id of ids) {
    if (id.network === "LINKEDIN" || id.network === "INSTAGRAM") continue;
    surfaces.push(universalOutreachSurface(id.network as SocialMessagingNetwork));
  }
  return surfaces;
}

export async function prepareProspectOutreach(input: {
  organisationId: string;
  prospectId: string;
  offerSummary?: string;
  brandTone?: string;
}) {
  const prospect = await prisma.socialProspect.findFirst({
    where: { id: input.prospectId, organisationId: input.organisationId },
  });
  if (!prospect) throw new Error("Prospect not found");

  const evidence = Array.isArray(prospect.sourceEvidence)
    ? (prospect.sourceEvidence as Array<{ excerpt?: string }>).map((e) => e.excerpt || "").filter(Boolean)
    : [];

  const icp = (prospect.icpSnapshot || {}) as { industry?: string };
  // Explicit offer/tone from the request win; otherwise speak for this workspace's business.
  const business = await loadOutreachBusinessContext(input.organisationId);
  const drafts = generateOutreachDrafts({
    personName: prospect.personName,
    companyName: prospect.companyName,
    role: prospect.role,
    location: prospect.location,
    sector: icp.industry,
    reasonSelected: prospect.reasonSelected,
    evidenceExcerpts: evidence,
    offerSummary: input.offerSummary?.trim() || business.offerSummary,
    brandTone: input.brandTone?.trim() || business.brandTone,
    businessName: business.businessName,
    audience: business.audience,
    evidenceConfidence: prospect.confidence,
  });

  const threads = [];
  const identities = showableIdentities(prospect.socialIdentities);
  const surfaces = buildActionSurfacesForProspect({
    linkedinUrl: prospect.linkedinUrl,
    instagramUrl: prospect.instagramUrl,
    socialIdentities: prospect.socialIdentities,
  });

  if (prospect.linkedinUrl || identities.some((i) => i.network === "LINKEDIN")) {
    const linkedIn = linkedInV1ActionSurface();
    const url =
      prospect.linkedinUrl ||
      identities.find((i) => i.network === "LINKEDIN")?.canonicalProfileUrl ||
      null;
    threads.push(
      await prisma.socialOutreachThread.create({
        data: {
          organisationId: input.organisationId,
          prospectId: prospect.id,
          contactId: prospect.contactId,
          network: SocialNetworkKind.LINKEDIN,
          status: SocialProspectStatus.CONNECTION_READY,
          actionMode: SocialActionMode.HUMAN_ACTION_REQUIRED,
          connectionNote: drafts.connectionNote,
          followUpOne: drafts.followUpOne,
          followUpTwo: drafts.followUpTwo,
          profileUrl: url,
          providerSent: false,
          metadata: { surface: linkedIn, version: "V1", actions: surfaces.find((s) => s.network === "LINKEDIN") },
        },
      }),
    );
  }

  if (prospect.instagramUrl || identities.some((i) => i.network === "INSTAGRAM")) {
    const url =
      prospect.instagramUrl ||
      identities.find((i) => i.network === "INSTAGRAM")?.canonicalProfileUrl ||
      null;
    threads.push(
      await prisma.socialOutreachThread.create({
        data: {
          organisationId: input.organisationId,
          prospectId: prospect.id,
          contactId: prospect.contactId,
          network: SocialNetworkKind.INSTAGRAM,
          status: SocialProspectStatus.OUTREACH_READY,
          actionMode: SocialActionMode.HUMAN_ACTION_REQUIRED,
          connectionNote: drafts.instagramMessage,
          followUpOne: drafts.instagramFollowUp,
          profileUrl: url,
          providerSent: false,
          metadata: {
            surface: {
              sendMessage: false,
              actions: ["OPEN_INSTAGRAM", "COPY_MESSAGE"],
              note: "Cold DM only when provider rules + existing conversation permit; otherwise Open/Copy",
            },
            actions: surfaces.find((s) => s.network === "INSTAGRAM"),
          },
        },
      }),
    );
  }

  for (const id of identities) {
    if (id.network === "LINKEDIN" || id.network === "INSTAGRAM") continue;
    threads.push(
      await prisma.socialOutreachThread.create({
        data: {
          organisationId: input.organisationId,
          prospectId: prospect.id,
          contactId: prospect.contactId,
          network: toPrismaNetwork(id.network),
          status: SocialProspectStatus.OUTREACH_READY,
          actionMode: SocialActionMode.HUMAN_ACTION_REQUIRED,
          connectionNote: drafts.genericSocialOutreach,
          followUpOne: drafts.genericSocialOutreach,
          profileUrl: id.canonicalProfileUrl,
          providerSent: false,
          metadata: {
            surface: universalOutreachSurface(id.network as SocialMessagingNetwork),
          },
        },
      }),
    );
  }

  await prisma.socialProspect.update({
    where: { id: prospect.id },
    data: { status: SocialProspectStatus.OUTREACH_READY },
  });

  return {
    drafts,
    threads,
    actionSurfaces: surfaces,
    linkedInSurface: linkedInV1ActionSurface(),
  };
}

export async function markOutreachState(input: {
  organisationId: string;
  threadId: string;
  action:
    | "CONNECTION_SENT"
    | "CONNECTED"
    | "FOLLOWUP_SENT"
    | "MESSAGE_SENT"
    | "REPLIED"
    | "LOST";
}) {
  const thread = await prisma.socialOutreachThread.findFirst({
    where: { id: input.threadId, organisationId: input.organisationId },
  });
  if (!thread) throw new Error("Outreach thread not found");

  const data: Record<string, unknown> = {
    lastOutcome: input.action,
    providerSent: false,
  };

  switch (input.action) {
    case "CONNECTION_SENT":
      data.status = SocialProspectStatus.CONNECTION_SENT;
      data.markedConnectionSentAt = new Date();
      break;
    case "CONNECTED":
      data.status = SocialProspectStatus.CONNECTED;
      data.markedConnectedAt = new Date();
      break;
    case "FOLLOWUP_SENT":
      data.status = SocialProspectStatus.MESSAGE_SENT;
      data.markedFollowUpSentAt = new Date();
      break;
    case "MESSAGE_SENT":
      data.status = SocialProspectStatus.MESSAGE_SENT;
      break;
    case "REPLIED":
      data.status = SocialProspectStatus.REPLIED;
      break;
    case "LOST":
      data.status = SocialProspectStatus.LOST;
      break;
  }

  const updated = await prisma.socialOutreachThread.update({
    where: { id: thread.id },
    data,
  });

  await prisma.socialProspect.update({
    where: { id: thread.prospectId },
    data: { status: updated.status },
  });

  return updated;
}
