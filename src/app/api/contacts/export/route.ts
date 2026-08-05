import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";

function escapeCsv(value: string | null | undefined) {
  return `"${(value ?? "").replace(/"/g, '""')}"`;
}

export async function GET(req: Request) {
  try {
    const session = await requirePermission("leads:read");
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
      ...contacts.map((c) => [
        escapeCsv(c.fullName), escapeCsv(c.instagramUsername), escapeCsv(c.email), escapeCsv(c.phone), escapeCsv(c.leadSource),
        c.leads[0]?.score ?? 0, escapeCsv(c.leads[0]?.stage?.name), c.optedOut ? "Yes" : "No",
        escapeCsv(c.tags.map(({ tag }) => tag.name).join("; ")), c.lastContactAt.toISOString(),
      ].join(",")),
    ].join("\n");
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="contacts.csv"' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    return jsonError(message, 500);
  }
}
