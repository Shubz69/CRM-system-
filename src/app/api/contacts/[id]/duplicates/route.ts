import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { errorResponse, HttpError } from "../../_lib/http";
import { findLiveContactsByIdentity, identityKeys, matchFields } from "../../_lib/identity";

type Params = { params: Promise<{ id: string }> };

const MAX_DUPLICATES = 20;

/**
 * GET /api/contacts/[id]/duplicates — other live contacts in this workspace with the same
 * email, phone number (digits compared) or Instagram handle (case-insensitive, no "@").
 */
export async function GET(_req: Request, { params }: Params) {
  try {
    const session = await requirePermission("leads:read");
    const { id } = await params;
    const contact = await prisma.contact.findFirst({
      where: { id, organisationId: session.organisationId, deletedAt: null },
      select: { id: true, email: true, phone: true, instagramUsername: true },
    });
    if (!contact) throw new HttpError(404, "Contact not found");

    const keys = identityKeys(contact);
    const candidates = await findLiveContactsByIdentity(prisma, {
      organisationId: session.organisationId,
      emails: keys.email ? [keys.email] : [],
      phones: keys.phone ? [keys.phone] : [],
      handles: keys.instagram ? [keys.instagram] : [],
      excludeContactId: contact.id,
      limit: MAX_DUPLICATES,
    });
    if (!candidates.length) return Response.json({ duplicates: [] });

    const details = await prisma.contact.findMany({
      where: {
        id: { in: candidates.map((c) => c.id) },
        organisationId: session.organisationId,
        deletedAt: null,
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        instagramUsername: true,
        leadSource: true,
        createdAt: true,
        lastContactAt: true,
        _count: {
          select: {
            conversations: { where: { deletedAt: null } },
            leads: { where: { deletedAt: null } },
            deals: { where: { deletedAt: null } },
            notes: true,
            bookings: true,
          },
        },
      },
    });
    const byId = new Map(details.map((d) => [d.id, d]));

    const duplicates = candidates.flatMap((candidate) => {
      const detail = byId.get(candidate.id);
      if (!detail) return [];
      const matchedOn = matchFields(keys, identityKeys(detail));
      if (!matchedOn.length) return [];
      const { _count, ...rest } = detail;
      return [{ ...rest, matchedOn, counts: _count }];
    });

    return Response.json({ duplicates });
  } catch (error) {
    return errorResponse(error, "Finding duplicates");
  }
}
