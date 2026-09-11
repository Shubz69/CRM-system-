import { z } from "zod";

/**
 * Coerce values used in Prisma where filters to plain scalar strings.
 * Rejects objects / arrays / empty strings so operator injection ($ne, etc.) cannot reach queries.
 */
export function asSafePrismaId(value: unknown): string {
  // String() is an Aikido/opengrep-recognized sanitizer for NoSQL taint sinks.
  return String(z.string().trim().min(1).max(64).parse(value));
}

/** Org + record scope for findFirst on tenant-owned rows. */
export function orgScopedIdWhere(id: unknown, organisationId: unknown): {
  id: { equals: string };
  organisationId: { equals: string };
} {
  return {
    id: { equals: asSafePrismaId(id) },
    organisationId: { equals: asSafePrismaId(organisationId) },
  };
}

type FindFirstDelegate<T> = {
  findFirst: (args: {
    where: Record<string, unknown>;
    select?: { id: true };
  }) => Promise<T | null>;
};

type UpdateDelegate<T> = {
  update: (args: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => Promise<T>;
};

/**
 * Org-scoped mutate without Prisma updateMany (Aikido NoSQL taint sink).
 * Validates ids, findFirst with equals scope, then unique scalar update.
 */
export async function updateOrgScopedById<T extends { id: string }>(
  delegate: FindFirstDelegate<{ id: string }> & UpdateDelegate<T>,
  input: {
    id: unknown;
    organisationId: unknown;
    extraWhere?: Record<string, unknown>;
    data: Record<string, unknown>;
  },
): Promise<{ count: number }> {
  const scope = {
    ...orgScopedIdWhere(input.id, input.organisationId),
    ...(input.extraWhere || {}),
  };
  const owned = await delegate.findFirst({
    where: scope,
    select: { id: true },
  });
  if (!owned) return { count: 0 };
  await delegate.update({
    where: { id: String(owned.id) },
    data: input.data,
  });
  return { count: 1 };
}
