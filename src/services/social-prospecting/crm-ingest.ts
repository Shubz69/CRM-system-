import { prisma } from "@/lib/db";
import { upsertDetectedOpportunity } from "@/services/opportunities/lifecycle";

/**
 * Canonical SocialProspect → Contact → Company → BusinessOpportunity ingestion.
 * Never overwrites higher-confidence CRM fields with lower-confidence research.
 */
export async function ingestProspectToCrm(input: {
  organisationId: string;
  prospectId: string;
  createOpportunity?: boolean;
}): Promise<{
  contactId: string;
  companyId: string | null;
  opportunityId: string | null;
}> {
  const prospect = await prisma.socialProspect.findFirst({
    where: { id: input.prospectId, organisationId: input.organisationId },
  });
  if (!prospect) throw new Error("Prospect not found");

  let companyId: string | null = prospect.companyId;
  if (prospect.companyName && !companyId) {
    const existingCompany = await prisma.company.findFirst({
      where: {
        organisationId: input.organisationId,
        deletedAt: null,
        name: { equals: prospect.companyName, mode: "insensitive" },
      },
    });
    if (existingCompany) {
      companyId = existingCompany.id;
      await prisma.company.update({
        where: { id: existingCompany.id },
        data: {
          website: existingCompany.website || prospect.companyWebsite || undefined,
          domain:
            existingCompany.domain ||
            (prospect.companyWebsite
              ? prospect.companyWebsite.replace(/^https?:\/\//, "").split("/")[0]
              : undefined),
        },
      });
    } else {
      const created = await prisma.company.create({
        data: {
          organisationId: input.organisationId,
          name: prospect.companyName,
          website: prospect.companyWebsite || undefined,
          domain: prospect.companyWebsite
            ? prospect.companyWebsite.replace(/^https?:\/\//, "").split("/")[0]
            : undefined,
          metadata: {
            provenance: "social_prospect",
            prospectId: prospect.id,
            sourceEvidence: prospect.sourceEvidence,
          },
        },
      });
      companyId = created.id;
    }
  }

  let contactId = prospect.contactId;
  if (!contactId) {
    const byLinkedIn = prospect.linkedinUrl
      ? await prisma.contactIdentifier.findFirst({
          where: {
            organisationId: input.organisationId,
            channel: "linkedin_url",
            identifier: prospect.linkedinUrl,
          },
        })
      : null;

    if (byLinkedIn) {
      contactId = byLinkedIn.contactId;
      const existing = await prisma.contact.findFirst({
        where: { id: contactId, organisationId: input.organisationId },
      });
      if (existing) {
        await prisma.contact.update({
          where: { id: existing.id },
          data: {
            fullName: existing.fullName || prospect.personName || undefined,
            companyId: existing.companyId || companyId || undefined,
            location: existing.location || prospect.location || undefined,
            instagramUsername:
              existing.instagramUsername ||
              (prospect.instagramUrl
                ? prospect.instagramUrl.replace(/\/$/, "").split("/").pop() || undefined
                : undefined),
            metadata: {
              ...(typeof existing.metadata === "object" && existing.metadata
                ? (existing.metadata as object)
                : {}),
              socialProspectId: prospect.id,
              provenance: "social_prospect",
            },
          },
        });
      }
    } else {
      const created = await prisma.contact.create({
        data: {
          organisationId: input.organisationId,
          companyId: companyId || undefined,
          fullName: prospect.personName || prospect.companyName || "Prospect",
          location: prospect.location || undefined,
          leadSource: "social_prospecting",
          instagramUsername: prospect.instagramUrl
            ? prospect.instagramUrl.replace(/\/$/, "").split("/").pop() || undefined
            : undefined,
          metadata: {
            provenance: "social_prospect",
            prospectId: prospect.id,
            linkedinUrl: prospect.linkedinUrl,
            instagramUrl: prospect.instagramUrl,
            sourceEvidence: prospect.sourceEvidence,
            confidence: prospect.confidence,
          },
        },
      });
      contactId = created.id;
      if (prospect.linkedinUrl) {
        await prisma.contactIdentifier.create({
          data: {
            organisationId: input.organisationId,
            contactId,
            channel: "linkedin_url",
            identifier: prospect.linkedinUrl,
          },
        });
      }
    }
  }

  let opportunityId: string | null = prospect.opportunityId;
  if (input.createOpportunity !== false) {
    const title = prospect.personName
      ? `Prospect: ${prospect.personName}${prospect.companyName ? ` @ ${prospect.companyName}` : ""}`
      : `Prospect: ${prospect.companyName || "Unknown"}`;
    const conf =
      (prospect.confidence ?? 0) >= 0.75 ? "HIGH" : (prospect.confidence ?? 0) >= 0.45 ? "MEDIUM" : "LOW";
    const evidences = Array.isArray(prospect.sourceEvidence)
      ? (prospect.sourceEvidence as Array<{ source?: string; url?: string; excerpt?: string }>).map(
          (e) => ({
            evidenceType: "research_source",
            label: e.source || "research",
            detail: e.excerpt || e.url || undefined,
            evidenceId: e.url || undefined,
          }),
        )
      : [];
    if (evidences.length === 0) {
      evidences.push({
        evidenceType: "social_prospect",
        label: "prospect_record",
        detail: prospect.reasonSelected || prospect.dedupeKey,
        evidenceId: undefined,
      });
    }
    const opp = await upsertDetectedOpportunity({
      organisationId: input.organisationId,
      type: "SOCIAL_PROSPECT",
      title,
      summary: prospect.reasonSelected || "Social prospect from research",
      source: "social_prospecting",
      dedupeKey: `social-prospect:${prospect.dedupeKey}`,
      impact: "MEDIUM",
      urgency: "MEDIUM",
      confidence: conf,
      evidences,
      scoreFactorsExtra: {
        fitScore: prospect.fitScore,
        confidence: prospect.confidence,
      },
      createdByAgent: "social_prospecting",
    });
    opportunityId = opp.opportunity.id;
  }

  await prisma.socialProspect.update({
    where: { id: prospect.id },
    data: {
      contactId,
      companyId,
      opportunityId,
      status: "QUALIFIED_LEAD",
    },
  });

  return { contactId: contactId!, companyId, opportunityId };
}
