import { createHash } from "crypto";
import type { NextAuthOptions } from "next-auth";
import type { JWT } from "next-auth/jwt";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/db";
import { getAuthSecret } from "@/lib/env";
import type { MemberRole } from "@prisma/client";
import { resolveActiveWorkspaceForUser } from "@/services/active-workspace";

export type SessionMembership = {
  organisationId: string;
  organisationName: string;
  role: MemberRole;
  isPlatform?: boolean;
};

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      organisationId?: string;
      organisationName?: string;
      role?: MemberRole;
      memberships?: SessionMembership[];
      mustChangePassword?: boolean;
      isPlatformAdmin?: boolean;
    };
  }

  interface User {
    id: string;
    email: string;
    name?: string | null;
    organisationId?: string;
    organisationName?: string;
    role?: MemberRole;
    memberships?: SessionMembership[];
    mustChangePassword?: boolean;
    isPlatformAdmin?: boolean;
    pwFp?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    organisationId?: string;
    organisationName?: string;
    role?: MemberRole;
    memberships?: SessionMembership[];
    mustChangePassword?: boolean;
    isPlatformAdmin?: boolean;
    /** Last time we re-checked the active workspace against the DB. */
    workspaceCheckedAt?: number;
    /** Fingerprint of the password hash at sign-in; a password change/reset revokes the token. */
    pwFp?: string;
  }
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

/** Short, non-reversible fingerprint of the stored bcrypt hash (never the hash itself). */
export function passwordFingerprint(passwordHash: string | null | undefined): string {
  if (!passwordHash) return "none";
  return createHash("sha256").update(`pwfp:${passwordHash}`).digest("base64url").slice(0, 16);
}

/**
 * Atomically count a sign-in attempt before checking the password, so parallel guesses
 * cannot slip past the lockout (the old read → bcrypt → write let N concurrent guesses
 * raise the counter by one). Returns false while the account is locked.
 *
 * Raw SQL on purpose: Prisma's @updatedAt would bump User.updatedAt, which is the
 * workspace revision the UI sends with every write — every failed login elsewhere used
 * to turn the user's open tabs into "Workspace changed in another tab" 409s.
 */
async function reserveLoginAttempt(userId: string): Promise<boolean> {
  // Columns are TIMESTAMP(3) holding UTC (Prisma's convention), so compare and write in
  // UTC explicitly rather than relying on the database session's TimeZone setting.
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

/** Strip identity claims so requireSession rejects the token and the user signs in again. */
function revokeToken(token: JWT): JWT {
  token.id = "";
  token.organisationId = undefined;
  token.organisationName = undefined;
  token.role = undefined;
  token.memberships = [];
  token.isPlatformAdmin = false;
  token.pwFp = undefined;
  return token;
}

async function recordSuccessfulLogin(userId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "User"
    SET "failedLoginAttempts" = 0, "lockedUntil" = NULL, "lastLoginAt" = timezone('UTC', now())
    WHERE "id" = ${userId}
  `;
}
/** Re-validate JWT org against DB at most every 5 minutes (Ask polls often; avoid pool storms). */
const WORKSPACE_RECHECK_MS = 5 * 60_000;

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  // Read lazily: processes that only import this module transitively (e.g. the worker)
  // must not crash at start-up because they have no auth secret.
  get secret() {
    return getAuthSecret();
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials.password) {
          return null;
        }

        const email = credentials.email.toLowerCase();

        const user = await prisma.user.findUnique({
          where: { email },
          include: {
            memberships: {
              include: { organisation: true },
              orderBy: { createdAt: "asc" },
            },
          },
        });

        if (!user?.passwordHash) return null;

        if (user.isSuspended || !user.isActive || user.deletedAt) {
          return null;
        }

        if (user.lockedUntil && user.lockedUntil > new Date()) {
          return null;
        }

        // Count the attempt first (atomic); a locked account never reaches bcrypt.
        if (!(await reserveLoginAttempt(user.id))) {
          return null;
        }

        const valid = await compare(credentials.password, user.passwordHash);
        if (!valid) {
          return null;
        }

        await recordSuccessfulLogin(user.id);

        // Explicit workspace selection — never "first SUPER_ADMIN" (ambiguous when
        // a user has multiple memberships including the platform org).
        const resolved = await resolveActiveWorkspaceForUser({
          userId: user.id,
          preferredOrganisationId: user.activeOrganisationId,
          persist: true,
        });

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          organisationId: resolved?.membership.organisationId,
          organisationName: resolved?.membership.organisation.name,
          role: resolved?.membership.role,
          memberships: resolved?.memberships ?? [],
          mustChangePassword: user.mustChangePassword,
          isPlatformAdmin: user.isPlatformAdmin,
          pwFp: passwordFingerprint(user.passwordHash),
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id;
        token.organisationId = user.organisationId;
        token.organisationName = user.organisationName;
        token.role = user.role;
        token.memberships = user.memberships ?? [];
        token.mustChangePassword = user.mustChangePassword ?? false;
        token.isPlatformAdmin = user.isPlatformAdmin ?? false;
        token.workspaceCheckedAt = Date.now();
        token.pwFp = user.pwFp;
      }

      if (trigger === "update" && session && typeof session === "object") {
        if ("mustChangePassword" in session && typeof session.mustChangePassword === "boolean") {
          token.mustChangePassword = session.mustChangePassword;
        }

        const nextOrgId =
          "organisationId" in session && typeof session.organisationId === "string"
            ? session.organisationId
            : undefined;

        if (token.id && nextOrgId) {
          const resolved = await resolveActiveWorkspaceForUser({
            userId: token.id,
            preferredOrganisationId: nextOrgId,
            persist: true,
          });
          if (resolved) {
            token.organisationId = resolved.membership.organisationId;
            token.organisationName = resolved.membership.organisation.name;
            token.role = resolved.membership.role;
            token.memberships = resolved.memberships;
            token.workspaceCheckedAt = Date.now();
          }
        }

        if (token.id) {
          const fresh = await prisma.user.findUnique({
            where: { id: token.id },
            select: { mustChangePassword: true, isPlatformAdmin: true, passwordHash: true },
          });
          if (fresh) {
            token.mustChangePassword = fresh.mustChangePassword;
            token.isPlatformAdmin = fresh.isPlatformAdmin;
            // The session that just changed its own password stays signed in.
            token.pwFp = passwordFingerprint(fresh.passwordHash);
          }
        }
      }

      // Prefer User.activeOrganisationId over a stale JWT org claim.
      // Cheap activeOrganisationId read runs every request; full membership resolve
      // runs when the durable org changed or the periodic recheck is due.
      // Soft-fail on DB errors — never turn a pool timeout into JWT_SESSION_ERROR / 401 spam.
      if (token.id) {
        try {
          const userRow = await prisma.user.findUnique({
            where: { id: token.id },
            select: {
              activeOrganisationId: true,
              passwordHash: true,
              isActive: true,
              isSuspended: true,
              deletedAt: true,
            },
          });
          // Suspension, deactivation, deletion and password changes/resets end every
          // other session on its next request (JWTs used to stay valid for 30 days).
          const fingerprint = passwordFingerprint(userRow?.passwordHash);
          if (
            !userRow ||
            !userRow.isActive ||
            userRow.isSuspended ||
            userRow.deletedAt ||
            (token.pwFp && token.pwFp !== fingerprint)
          ) {
            return revokeToken(token);
          }
          // Tokens issued before fingerprints existed adopt the current one.
          if (!token.pwFp) token.pwFp = fingerprint;
          const preferred =
            userRow?.activeOrganisationId || token.organisationId || null;
          const orgChanged =
            Boolean(preferred) && preferred !== token.organisationId;
          const due =
            !token.workspaceCheckedAt ||
            Date.now() - token.workspaceCheckedAt > WORKSPACE_RECHECK_MS;
          if (due || orgChanged) {
            const resolved = await resolveActiveWorkspaceForUser({
              userId: token.id,
              preferredOrganisationId: preferred,
              // Only write when the resolved org differs — avoids extra writes under Ask polling.
              persist: orgChanged || !token.organisationId,
            });
            if (!resolved) {
              token.organisationId = undefined;
              token.organisationName = undefined;
              token.role = undefined;
              token.memberships = [];
            } else {
              token.organisationId = resolved.membership.organisationId;
              token.organisationName = resolved.membership.organisation.name;
              token.role = resolved.membership.role;
              token.memberships = resolved.memberships;
            }
            token.workspaceCheckedAt = Date.now();
          }
        } catch (error) {
          // Keep the existing JWT claims; retry on a later request.
          console.warn(
            "[auth] workspace recheck skipped",
            error instanceof Error ? error.message : "unknown",
          );
          token.workspaceCheckedAt = Date.now();
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
        session.user.organisationId = token.organisationId;
        session.user.organisationName = token.organisationName;
        session.user.role = token.role;
        session.user.memberships = token.memberships ?? [];
        session.user.mustChangePassword = token.mustChangePassword ?? false;
        session.user.isPlatformAdmin = token.isPlatformAdmin ?? false;
      }
      return session;
    },
  },
};
