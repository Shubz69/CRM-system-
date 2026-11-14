import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, requirePermission } from "@/lib/session";
import { getSheetsAdapter } from "@/adapters/sheets";
import { getEmailAdapter } from "@/adapters/email";
import { writeAuditLog } from "@/services/audit";

const exportSchema = z.object({
  reportId: z.string().min(1),
  destination: z.enum(["sheets", "email", "csv"]),
  emailTo: z.array(z.string().email()).optional(),
});

export async function POST(req: Request) {
  try {
    // reports:export exists for exactly this; reports:read let READ_ONLY / SALES_AGENT
    // users mail workspace data to any address through the platform mailer.
    const session = await requirePermission("reports:export");
    const body = exportSchema.parse(await req.json());

    const report = await prisma.report.findFirst({
      where: { id: body.reportId, organisationId: session.organisationId },
    });
    if (!report) return jsonError("Report not found", 404);

    const payload =
      report.payload && typeof report.payload === "object"
        ? (report.payload as Record<string, unknown>)
        : {};

    if (body.destination === "csv") {
      const rows = [
        ["metric", "value"],
        ["newConversations", String(payload.newConversations ?? "")],
        ["qualifiedLeads", String(payload.qualifiedLeads ?? "")],
        ["callsBooked", String(payload.callsBooked ?? "")],
        ["followUpsSent", String(payload.followUpsSent ?? "")],
        ["conversionRate", String(payload.conversionRate ?? "")],
      ];
      const csv = rows.map((r) => r.join(",")).join("\n");
      return Response.json({ ok: true, destination: "csv", csv });
    }

    if (body.destination === "sheets") {
      const result = await getSheetsAdapter().exportReport({
        organisationId: session.organisationId,
        reportId: report.id,
        title: report.title,
        type: report.type,
        payload,
      });
      await writeAuditLog({
        organisationId: session.organisationId,
        userId: session.userId,
        action: "report.export.sheets",
        entityType: "Report",
        entityId: report.id,
        metadata: { ok: result.ok, provider: result.provider },
      });
      if (!result.ok) return jsonError(result.error || "Sheets export failed", 502);
      return Response.json({ ok: true, result });
    }

    const recipients = body.emailTo?.length
      ? body.emailTo
      : session.email
        ? [session.email]
        : [];
    if (!recipients.length) return jsonError("emailTo is required for email export", 400);

    // Reports may only be emailed to people in this workspace.
    const memberEmails = new Set(
      (
        await prisma.organisationMember.findMany({
          where: { organisationId: session.organisationId },
          select: { user: { select: { email: true } } },
        })
      ).map((m) => m.user.email.toLowerCase()),
    );
    const outsiders = recipients.filter((r) => !memberEmails.has(r.toLowerCase()));
    if (outsiders.length) {
      return jsonError("Reports can only be emailed to members of this workspace.", 400);
    }

    const result = await getEmailAdapter().send({
      organisationId: session.organisationId,
      to: recipients,
      subject: `${report.title} (${report.type})`,
      bodyText: JSON.stringify(payload, null, 2),
      metadata: { reportId: report.id },
    });
    await writeAuditLog({
      organisationId: session.organisationId,
      userId: session.userId,
      action: "report.export.email",
      entityType: "Report",
      entityId: report.id,
      metadata: { ok: result.ok, provider: result.provider },
    });
    if (!result.ok) return jsonError(result.error || "Email export failed", 502);
    return Response.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
