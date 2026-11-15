import { z } from "zod";
import { jsonError, requirePermission } from "@/lib/session";
import {
  createAudienceSegment,
  createEntityRelation,
  createProductOffering,
  findAudienceSegmentByName,
  findLiveProductOfferingByName,
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

const FIELD_LABELS: Record<string, string> = {
  action: "Action",
  name: "Name",
  description: "Description",
  evidenceNote: "Evidence note",
  confidence: "Confidence",
  priceMinCents: "Minimum price",
  priceMaxCents: "Maximum price",
  attributes: "Attributes",
};

/** One readable sentence for the first problem — never zod's raw issue JSON. */
function readableBodyError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Check the details and try again.";
  const field = String(issue.path[0] ?? "");
  if (field === "action") return "That isn't something the business profile can do.";
  const label = FIELD_LABELS[field] ?? "A field";
  if (issue.code === "too_small") return `${label} can't be empty.`;
  if (issue.code === "too_big") {
    const max = (issue as { maximum?: number | bigint }).maximum;
    return max != null ? `${label} must be ${String(max)} characters or fewer.` : `${label} is too long.`;
  }
  if (field === "confidence") return "Confidence must be between 0 and 1.";
  return `${label} is invalid.`;
}

export async function POST(req: Request) {
  try {
    const session = await requirePermission("agent:manage");
    const body = bodySchema.parse(await req.json());

    if (body.action === "create_product") {
      if (!body.name?.trim()) return jsonError("Enter the product or service name.", 400);
      const alreadyExisted = Boolean(
        await findLiveProductOfferingByName(session.organisationId, body.name),
      );
      const product = await createProductOffering({
        organisationId: session.organisationId,
        name: body.name,
        description: body.description,
        category: body.category,
        priceMinCents: body.priceMinCents,
        priceMaxCents: body.priceMaxCents,
        currency: body.currency,
      });
      return Response.json({ product, alreadyExisted });
    }
    if (body.action === "create_audience") {
      if (!body.name?.trim()) return jsonError("Enter the audience name.", 400);
      const alreadyExisted = Boolean(
        await findAudienceSegmentByName(session.organisationId, body.name),
      );
      const segment = await createAudienceSegment({
        organisationId: session.organisationId,
        name: body.name,
        description: body.description,
        attributes: body.attributes,
        evidenceNote: body.evidenceNote,
        confidence: body.confidence,
      });
      return Response.json({ segment, alreadyExisted });
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
        return jsonError("Choose both items and how they're related.", 400);
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
        return jsonError("Say what the fact is about, what it is and where it came from.", 400);
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
    return jsonError("That isn't something the business profile can do.", 400);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError(readableBodyError(error), 400);
    if (error instanceof SyntaxError) return jsonError("Invalid request body.", 400);
    const message = error instanceof Error ? error.message : "Failed";
    if (message === "UNAUTHORIZED") return jsonError("Unauthorized", 401);
    if (message.startsWith("Forbidden")) return jsonError(message, 403);
    if (/^Entity \S+ not found in organisation$/.test(message)) {
      return jsonError("One of those items isn't in this workspace.", 404);
    }
    // Service checks (e.g. "Sensitive attribute … is not allowed") are already sentences;
    // anything else is internal and is not shown.
    if (/^Sensitive attribute /.test(message)) return jsonError(`${message}.`, 400);
    if (message === "Invalid entity type" || message === "Invalid relationship type") {
      return jsonError("That kind of link isn't supported in the business profile.", 400);
    }
    if (message === "Cross-org entity rejected") {
      return jsonError("One of those items isn't in this workspace.", 404);
    }
    return jsonError("Couldn't save that to the business profile. Try again.", 500);
  }
}
