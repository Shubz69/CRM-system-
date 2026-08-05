import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export async function upsertCampaignAttribution(input: {
  organisationId: string;
  contactId: string;
  leadId?: string;
  campaignSource?: string | null;
  leadSource?: string | null;
  medium?: string | null;
  content?: string | null;
}): Promise<{ campaignId: string | null; attributionId: string | null }> {
  if (!input.campaignSource && !input.leadSource) {
    return { campaignId: null, attributionId: null };
  }

  let campaignId: string | null = null;

  if (input.campaignSource) {
    const campaign = await prisma.campaign.upsert({
      where: {
        organisationId_name: {
          organisationId: input.organisationId,
          name: input.campaignSource,
        },
      },
      create: {
        organisationId: input.organisationId,
        name: input.campaignSource,
        source: input.leadSource ?? "instagram",
      },
      update: {},
    });
    campaignId = campaign.id;

    if (input.leadId) {
      await prisma.lead.update({
        where: { id: input.leadId },
        data: { campaignId },
      });
    }
  }

  const attribution = await prisma.attribution.create({
    data: {
      organisationId: input.organisationId,
      contactId: input.contactId,
      leadId: input.leadId,
      campaignId: campaignId ?? undefined,
      source: input.leadSource ?? "instagram",
      medium: input.medium ?? "social",
      content: input.content ?? input.campaignSource ?? undefined,
      metadata: {
        firstTouch: true,
        lastTouch: true,
      },
    },
  });

  logger.info("Attribution recorded", {
    organisationId: input.organisationId,
    attributionId: attribution.id,
    campaignId,
  });

  return { campaignId, attributionId: attribution.id };
}
