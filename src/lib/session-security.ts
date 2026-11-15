import { createHash, createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { getAuthSecret } from "@/lib/env";

/**
 * Sign-in hardening shared by the login form and invite acceptance.
 *
 * Sessions are stateless JWTs, so revocation works by fingerprint: every token carries a
 * fingerprint of (password hash + "revoke all sessions" marker). Changing or resetting
 * the password, or an admin ending all sessions, changes the fingerprint and every older
 * token stops working on its next request.
 */

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_DURATION_MS = 15 * 60 * 1000;
const REFRESH_PROOF_MAX_AGE_MS = 5 * 60_000;

/**
 * "End all sessions" marker. Stored in the (otherwise unused) Session table so no schema
 * change is needed: one row per user, `expires` holds the moment sessions were revoked.
 */
export function revocationMarkerToken(userId: string): string {
  return `revoked:${userId}`;
}

/** Fingerprint of the stored password hash + revocation marker (never the hash itself). */
export function sessionFingerprint(
  passwordHash: string | null | undefined,
  sessionsRevokedAt?: Date | null,
): string {
  const base = `pwfp:${passwordHash ?? "none"}:${sessionsRevokedAt ? sessionsRevokedAt.toISOString() : ""}`;
  return createHash("sha256").update(base).digest("base64url").slice(0, 16);
}

/** Everything needed to compute a user's current fingerprint, in one query. */
export async function loadSessionFingerprint(userId: string): Promise<{
  fingerprint: string;
  passwordHash: string | null;
  isActive: boolean;
  isSuspended: boolean;
  deletedAt: Date | null;
  activeOrganisationId: string | null;
  mustChangePassword: boolean;
  isPlatformAdmin: boolean;
} | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      passwordHash: true,
      isActive: true,
      isSuspended: true,
      deletedAt: true,
      activeOrganisationId: true,
      mustChangePassword: true,
      isPlatformAdmin: true,
      sessions: {
        where: { sessionToken: revocationMarkerToken(userId) },
        select: { expires: true },
        take: 1,
      },
    },
  });
  if (!user) return null;
  const { sessions, ...rest } = user;
  return { ...rest, fingerprint: sessionFingerprint(user.passwordHash, sessions[0]?.expires ?? null) };
}

/** Admin "end all sessions": every token issued before now stops working. */
export async function revokeAllSessions(userId: string): Promise<void> {
  const now = new Date();
  await prisma.session.upsert({
    where: { sessionToken: revocationMarkerToken(userId) },
    create: { sessionToken: revocationMarkerToken(userId), userId, expires: now },
    update: { expires: now },
  });
}

function hmac(value: string): string {
  return createHmac("sha256", getAuthSecret()).update(value).digest("base64url");
}

/**
 * Proof that the caller just changed this user's password (they knew the old one). The
 * change-password page passes it to the session `update()` so only that browser adopts
 * the new fingerprint — a bare update() from a stolen cookie can no longer do that.
 */
export function signSessionRefreshProof(userId: string, fingerprint: string, now = Date.now()): string {
  return `${now}.${hmac(`refresh:${userId}:${fingerprint}:${now}`)}`;
}

export function verifySessionRefreshProof(
  proof: unknown,
  userId: string,
  fingerprint: string,
  now = Date.now(),
): boolean {
  if (typeof proof !== "string") return false;
  const dot = proof.indexOf(".");
  if (dot <= 0) return false;
  const issuedAt = Number(proof.slice(0, dot));
  if (!Number.isFinite(issuedAt) || now - issuedAt > REFRESH_PROOF_MAX_AGE_MS || issuedAt > now + 60_000) {
    return false;
  }
  const expected = Buffer.from(hmac(`refresh:${userId}:${fingerprint}:${issuedAt}`));
  const actual = Buffer.from(proof.slice(dot + 1));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Atomically count a password attempt before checking it, so parallel guesses cannot
 * slip past the lockout. Returns false while the account is locked.
 *
 * Raw SQL on purpose: Prisma's @updatedAt would bump User.updatedAt, which is the
 * workspace revision the UI sends with every write. Columns are TIMESTAMP(3) holding UTC,
 * so compare and write in UTC regardless of the database session's TimeZone.
 */
export async function reserveLoginAttempt(userId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "User"
    SET
      "failedLoginAttempts" = CASE
        WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= timezone('UTC', now()) THEN 1
        ELSE "failedLoginAttempts" + 1
      END,
      "lockedUntil" = CASE
        WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= timezone('UTC', now()) THEN NULL
        WHEN "failedLoginAttempts" + 1 >= ${MAX_FAILED_ATTEMPTS}::integer
          THEN timezone('UTC', now()) + (${LOCK_DURATION_MS}::double precision * INTERVAL '1 millisecond')
        ELSE "lockedUntil"
      END
    WHERE "id" = ${userId}
      AND ("lockedUntil" IS NULL OR "lockedUntil" <= timezone('UTC', now()))
    RETURNING "id"
  `;
  return rows.length > 0;
}

export async function recordSuccessfulLogin(userId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "User"
    SET "failedLoginAttempts" = 0, "lockedUntil" = NULL, "lastLoginAt" = timezone('UTC', now())
    WHERE "id" = ${userId}
  `;
}

/** First address in X-Forwarded-For (the client), for per-IP throttles. */
export function clientIp(forwardedFor: string | null | undefined): string {
  return (forwardedFor || "").split(",")[0]?.trim() || "unknown";
}
