import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";

export const TAG_NAME_MAX = 40;
export const DEFAULT_TAG_COLOR = "#64748b";

export const tagNameSchema = z
  .string({ required_error: "Tag name is required.", invalid_type_error: "Tag name must be text." })
  .transform((v) => v.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, "Tag name is required.")
      .max(TAG_NAME_MAX, `Tag names can be at most ${TAG_NAME_MAX} characters.`),
  );

export const tagColorSchema = z
  .string({ invalid_type_error: "Colour must be a hex value like #0c6b64." })
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Colour must be a hex value like #0c6b64.")
  .transform((v) => v.toLowerCase());

/** Tag names are unique per workspace, compared case-insensitively ("VIP" = "vip"). */
export async function findTagByName(organisationId: string, name: string, excludeId?: string) {
  return prisma.tag.findFirst({
    where: {
      organisationId,
      name: { equals: name, mode: "insensitive" },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, name: true, color: true },
  });
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Find-or-create a tag by name (case-insensitive). Safe against a concurrent create:
 * a unique violation re-reads the row the other request inserted.
 */
export async function findOrCreateTag(
  organisationId: string,
  name: string,
  color?: string,
): Promise<{ tag: { id: string; name: string; color: string }; created: boolean }> {
  const existing = await findTagByName(organisationId, name);
  if (existing) return { tag: existing, created: false };
  try {
    const tag = await prisma.tag.create({
      data: { organisationId, name, color: color ?? DEFAULT_TAG_COLOR },
      select: { id: true, name: true, color: true },
    });
    return { tag, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findTagByName(organisationId, name);
    if (!raced) throw error;
    return { tag: raced, created: false };
  }
}

/**
 * Resolve many tag names to ids for one workspace, creating the missing ones (CSV import).
 * Returns a lower-cased name → id map and how many tags were created.
 */
export async function ensureTagsByName(
  organisationId: string,
  names: string[],
): Promise<{ idsByLowerName: Map<string, string>; created: number }> {
  const wanted = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, " ");
    if (name && name.length <= TAG_NAME_MAX && !wanted.has(name.toLowerCase())) {
      wanted.set(name.toLowerCase(), name);
    }
  }
  const idsByLowerName = new Map<string, string>();
  if (!wanted.size) return { idsByLowerName, created: 0 };

  const load = async () => {
    const tags = await prisma.tag.findMany({
      where: { organisationId },
      select: { id: true, name: true },
    });
    for (const t of tags) {
      const key = t.name.toLowerCase();
      if (wanted.has(key) && !idsByLowerName.has(key)) idsByLowerName.set(key, t.id);
    }
  };

  await load();
  const missing = [...wanted.entries()].filter(([key]) => !idsByLowerName.has(key));
  let created = 0;
  if (missing.length) {
    const result = await prisma.tag.createMany({
      data: missing.map(([, name]) => ({ organisationId, name, color: DEFAULT_TAG_COLOR })),
      skipDuplicates: true,
    });
    created = result.count;
    await load();
  }
  return { idsByLowerName, created };
}
