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

/**
 * Generate personalised outreach copy grounded only in provided evidence.
 * Never invents that the user saw a post/event without evidence.
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

  const offer = input.offerSummary?.trim() || "how we help similar teams save time with AI operations";
  const tone = (input.brandTone || "professional, concise").toLowerCase();

  const connectionNote = [
    `Hi ${name} — ${grounded}.`,
    `Would be glad to connect and share a short note on ${offer}.`,
  ]
    .join(" ")
    .slice(0, 280);

  const followUpOne = [
    `Hi ${name}, thanks for connecting.`,
    strong && input.companyName
      ? `Curious whether ${input.companyName} is exploring ${offer}? Happy to share a 2-minute overview if useful.`
      : `Curious whether this is on your radar — happy to share a 2-minute overview if useful.`,
  ].join(" ");

  const followUpTwo = [
    `Hi ${name} — circling back once.`,
    `If timing is off, no worries — happy to share a brief resource whenever it helps.`,
  ].join(" ");

  const instagramMessage = [
    `Hi ${name} — ${grounded}.`,
    tone.includes("casual")
      ? `Thought this might be relevant.`
      : `Sharing a concise idea that may help.`,
  ].join(" ");

  const instagramFollowUp = `Hi ${name}, just following up in case my earlier note was buried. Happy to keep it short.`;

  const genericSocialOutreach = [
    `Hi ${name} — ${grounded}.`,
    `If useful, I can share a brief note on ${offer}.`,
  ].join(" ");

  const emailDraft = input.email
    ? [
        `Subject: Quick idea${strong && input.companyName ? ` for ${input.companyName}` : ""}`,
        "",
        `Hi ${name},`,
        "",
        grounded + ".",
        "",
        `If helpful, I can share how we approach ${offer}.`,
        "",
        "Best regards",
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
  const drafts = generateOutreachDrafts({
    personName: prospect.personName,
    companyName: prospect.companyName,
    role: prospect.role,
    location: prospect.location,
    sector: icp.industry,
    reasonSelected: prospect.reasonSelected,
    evidenceExcerpts: evidence,
    offerSummary: input.offerSummary,
    brandTone: input.brandTone,
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
