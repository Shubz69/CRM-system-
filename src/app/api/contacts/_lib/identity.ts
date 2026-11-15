import { Prisma } from "@prisma/client";
import { z } from "zod";

/**
 * How two contacts are recognised as the same person: same email, same phone number
 * (digits only, so "+1 (555) 010-2000" matches "15550102000") or same Instagram handle
 * (case-insensitive, without "@"). Only live contacts (deletedAt null) ever match.
 */
export type MatchField = "email" | "phone" | "instagram";

export type IdentityKeys = {
  email: string | null;
  phone: string | null;
  instagram: string | null;
};

const emailSchema = z.string().email();

export function normaliseEmail(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase();
  return v ? v : null;
}

export function isValidEmail(value: string): boolean {
  return emailSchema.safeParse(value).success;
}

/** Digits only; null when there are too few digits to be a phone number. */
export function phoneDigits(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
}

/**
 * "@Ada.Shop", "ada.shop", "https://www.instagram.com/ada.shop/?hl=en" → "ada.shop".
 * Returns the cleaned value even if it is not a valid handle (see isValidInstagramHandle).
 */
export function normaliseInstagram(value: string | null | undefined): string | null {
  let v = (value ?? "").trim();
  if (!v) return null;
  v = v.replace(/^(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\//i, "");
  v = v.split(/[/?#]/)[0] ?? "";
  v = v.replace(/^@+/, "").trim().toLowerCase();
  return v || null;
}

export function isValidInstagramHandle(handle: string): boolean {
  return /^[a-z0-9._]{1,30}$/.test(handle);
}

export function identityKeys(contact: {
  email?: string | null;
  phone?: string | null;
  instagramUsername?: string | null;
}): IdentityKeys {
  return {
    email: normaliseEmail(contact.email),
    phone: phoneDigits(contact.phone),
    instagram: normaliseInstagram(contact.instagramUsername),
  };
}

/** Which identity fields two records share. */
export function matchFields(a: IdentityKeys, b: IdentityKeys): MatchField[] {
  const fields: MatchField[] = [];
  if (a.email && a.email === b.email) fields.push("email");
  if (a.phone && a.phone === b.phone) fields.push("phone");
  if (a.instagram && a.instagram === b.instagram) fields.push("instagram");
  return fields;
}

export type IdentityCandidate = {
  id: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  instagramUsername: string | null;
};

type RawQueryClient = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Prisma.PrismaPromise<T>;
};

/**
 * Live contacts in one workspace sharing any of the given emails / phone digits / handles.
 * One query, normalised in SQL the same way as above, always scoped by organisation.
 */
export async function findLiveContactsByIdentity(
  db: RawQueryClient,
  input: {
    organisationId: string;
    emails: string[];
    phones: string[];
    handles: string[];
    excludeContactId?: string;
    limit?: number;
  },
): Promise<IdentityCandidate[]> {
  const emails = [...new Set(input.emails.filter(Boolean))];
  const phones = [...new Set(input.phones.filter(Boolean))];
  const handles = [...new Set(input.handles.filter(Boolean))];
  if (!emails.length && !phones.length && !handles.length) return [];

  return db.$queryRaw<IdentityCandidate[]>(Prisma.sql`
    SELECT "id", "fullName", "email", "phone", "instagramUsername"
    FROM "Contact"
    WHERE "organisationId" = ${input.organisationId}
      AND "deletedAt" IS NULL
      ${input.excludeContactId ? Prisma.sql`AND "id" <> ${input.excludeContactId}` : Prisma.empty}
      AND (
        lower(btrim("email")) = ANY(${emails}::text[])
        OR regexp_replace(COALESCE("phone", ''), '[^0-9]', '', 'g') = ANY(${phones}::text[])
        OR lower(regexp_replace(btrim("instagramUsername"), '^@+', '')) = ANY(${handles}::text[])
      )
    ORDER BY "lastContactAt" DESC, "id" DESC
    ${input.limit ? Prisma.sql`LIMIT ${input.limit}` : Prisma.empty}
  `);
}
