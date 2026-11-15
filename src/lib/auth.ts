import type { NextAuthOptions } from "next-auth";
import type { JWT } from "next-auth/jwt";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/db";
import { getAuthSecret } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import {
  clientIp,
  loadSessionFingerprint,
  recordSuccessfulLogin,
  reserveLoginAttempt,
  verifySessionRefreshProof,
} from "@/lib/session-security";
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

/** Per-IP sign-in throttle on top of the per-account lockout (in-memory, per instance). */
const LOGIN_ATTEMPTS_PER_IP_PER_MINUTE = 20;

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
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials.password) {
          return null;
        }

        // Spraying many accounts from one address is throttled before any database work.
        const forwarded = req?.headers?.["x-forwarded-for"];
        const ip = clientIp(Array.isArray(forwarded) ? forwarded[0] : forwarded);
        if (!rateLimit(`login:${ip}`, LOGIN_ATTEMPTS_PER_IP_PER_MINUTE, 60_000)) {
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
        const current = await loadSessionFingerprint(user.id);

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
          pwFp: current?.fingerprint,
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
          const fresh = await loadSessionFingerprint(token.id);
          if (fresh) {
            token.mustChangePassword = fresh.mustChangePassword;
            token.isPlatformAdmin = fresh.isPlatformAdmin;
            // Only the browser that just changed the password (it holds the signed proof
            // returned by /api/account/password) adopts the new fingerprint. A bare update()
            // from any other cookie — e.g. a stolen one — must not, or it would survive
            // the password change it is supposed to be revoked by.
            if (
              "sessionRefreshProof" in session &&
              verifySessionRefreshProof(session.sessionRefreshProof, token.id, fresh.fingerprint)
            ) {
              token.pwFp = fresh.fingerprint;
            }
          }
        }
      }

      // Prefer User.activeOrganisationId over a stale JWT org claim.
      // Cheap activeOrganisationId read runs every request; full membership resolve
      // runs when the durable org changed or the periodic recheck is due.
      // Soft-fail on DB errors — never turn a pool timeout into JWT_SESSION_ERROR / 401 spam.
      if (token.id) {
        try {
          const userRow = await loadSessionFingerprint(token.id);
          // Suspension, deactivation, deletion, password changes/resets and an admin's
          // "end all sessions" end every other session on its next request (JWTs used to
          // stay valid for 30 days). Tokens without a fingerprint predate this check and
          // can't be revoked any other way, so they sign in again once.
          if (
            !userRow ||
            !userRow.isActive ||
            userRow.isSuspended ||
            userRow.deletedAt ||
            !token.pwFp ||
            token.pwFp !== userRow.fingerprint
          ) {
            return revokeToken(token);
          }
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
