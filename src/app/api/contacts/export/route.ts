import { prisma } from "@/lib/db";
import { csvRow } from "@/lib/csv";
import { jsonError, requirePermission } from "@/lib/session";
import { writeAuditLog } from "@/services/audit";

export async function GET(req: Request) {
  try {
    // A full contact export is a data export — leads:read let READ_ONLY users download
    // every contact's personal details.
    const session = await requirePermission("reports:export");
    const q = new URL(req.url).searchParams.get("q")?.trim();
    const contacts = await prisma.contact.findMany({
      where: {
        organisationId: session.organisationId,
        deletedAt: null,
        ...(q ? { OR: [{ fullName: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { phone: { contains: q, mode: "insensitive" } }, { instagramUsername: { contains: q, mode: "insensitive" } }] } : {}),
      },
      include: { leads: { where: { deletedAt: null }, take: 1, include: { stage: true } }, tags: { include: { tag: true } } },
      orderBy: { lastContactAt: "desc" },
    });
    const csv = [
      "Name,Instagram,Email,Phone,Source,Score,Stage,Opted out,Tags,Last contact",
      ...contacts.map((c) =>
        csvRow([
          c.fullName,
          c.instagramUsername,
          c.email,
          c.phone,
          c.leadSource,
          c.leads[0]?.score ?? 0,
          c.leads[0]?.stage?.name,
          c.optedOut ? "Yes" : "No",
          c.tags.map(({ tag }) => tag.name).join("; "),
          c.lastContactAt.toISOString(),
        ]),
      ),
    ].join("\n");
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "contacts.export.csv",
      entityType: "Contact",
      entityId: session.organisationId,
      metadata: { count: contacts.length, filtered: Boolean(q) },
    });
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="contacts.csv"' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError("You don't have permission to export contacts.", 403);
    return jsonError(message, 500);
  }
}
