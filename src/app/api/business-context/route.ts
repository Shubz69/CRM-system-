import { z } from "zod";
import { jsonError, requirePermission } from "@/lib/session";
import {
  createAudienceSegment,
  createEntityRelation,
  createProductOffering,
  getBusinessContextCompleteness,
  getBusinessProfile,
  upsertBusinessClaim,
} from "@/services/digital-twin";

/**
 * GET /api/business-context — Digital Twin overview (read-only aggregation).
 */
export async function GET() {
  try {
    const session = await requirePermission("insights:read");
    const [profile, completeness] = await Promise.all([
      getBusinessProfile(session.organisationId),
      getBusinessContextCompleteness(session.organisationId),
    ]);
    return Response.json({ profile, completeness: completeness.items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 500);
  }
}

const bodySchema = z.object({
  action: z.enum(["create_product", "create_audience", "create_relation", "upsert_claim"]),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  category: z.string().optional(),
  priceMinCents: z.number().int().optional(),
  priceMaxCents: z.number().int().optional(),
  currency: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  evidenceNote: z.string().max(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceType: z.string().optional(),
  sourceId: z.string().optional(),
  relationshipType: z.string().optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  source: z.string().optional(),
  evidenceReference: z.string().optional(),
  subjectType: z.string().optional(),
  subjectId: z.string().optional(),
  predicate: z.string().optional(),
  valueText: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const session = await requirePermission("agent:manage");
    const body = bodySchema.parse(await req.json());

    if (body.action === "create_product") {
      if (!body.name) return jsonError("name required", 400);
      const product = await createProductOffering({
        organisationId: session.organisationId,
        name: body.name,
        description: body.description,
        category: body.category,
        priceMinCents: body.priceMinCents,
        priceMaxCents: body.priceMaxCents,
        currency: body.currency,
      });
      return Response.json({ product });
    }
    if (body.action === "create_audience") {
      if (!body.name) return jsonError("name required", 400);
      const segment = await createAudienceSegment({
        organisationId: session.organisationId,
        name: body.name,
        description: body.description,
        attributes: body.attributes,
        evidenceNote: body.evidenceNote,
        confidence: body.confidence,
      });
      return Response.json({ segment });
    }
    if (body.action === "create_relation") {
      if (
        !body.sourceType ||
        !body.sourceId ||
        !body.relationshipType ||
        !body.targetType ||
        !body.targetId ||
        !body.source
      ) {
        return jsonError("relation fields required", 400);
      }
      const relation = await createEntityRelation({
        organisationId: session.organisationId,
        sourceType: body.sourceType,
        sourceId: body.sourceId,
        relationshipType: body.relationshipType,
        targetType: body.targetType,
        targetId: body.targetId,
        source: body.source,
        evidenceReference: body.evidenceReference,
        confidence: body.confidence,
      });
      return Response.json({ relation });
    }
    if (body.action === "upsert_claim") {
      if (!body.subjectType || !body.subjectId || !body.predicate || !body.source) {
        return jsonError("claim fields required", 400);
      }
      const claim = await upsertBusinessClaim({
        organisationId: session.organisationId,
        subjectType: body.subjectType,
        subjectId: body.subjectId,
        predicate: body.predicate,
        valueText: body.valueText,
        source: body.source,
        evidenceReference: body.evidenceReference,
        confidence: body.confidence,
      });
      return Response.json({ claim });
    }
    return jsonError("Unknown action", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    return jsonError(message, 400);
  }
}
