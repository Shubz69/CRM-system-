import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/session";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({
      ok: true,
      service: "database",
      timestamp: new Date().toISOString(),
    });
  } catch {
    return jsonError("Database unavailable", 503);
  }
}
