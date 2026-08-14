import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/db";
import { getAuthSecret, isDemoModeEnabled } from "@/lib/env";
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
  }
}

const DEMO_EMAIL = "demo@dminelligence.local";
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
/** Re-validate JWT org against DB at most every 60s (keeps stale IDs from surviving a reseed). */
const WORKSPACE_RECHECK_MS = 60_000;

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  secret: getAuthSecret(),
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
        if (email === DEMO_EMAIL && !isDemoModeEnabled()) {
          return null;
        }

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

        const valid = await compare(credentials.password, user.passwordHash);
        if (!valid) {
          const attempts = user.failedLoginAttempts + 1;
          const lock =
            attempts >= MAX_FAILED_ATTEMPTS
              ? new Date(Date.now() + LOCK_DURATION_MS)
              : null;
          await prisma.user.update({
            where: { id: user.id },
            data: {
              failedLoginAttempts: attempts,
              lockedUntil: lock,
            },
          });
          return null;
        }

        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: 0,
            lockedUntil: null,
            lastLoginAt: new Date(),
          },
        });

        // Explicit workspace selection — never "first SUPER_ADMIN" (ambiguous when
        // the user is SUPER_ADMIN on both Demo Agency and the platform org).
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
            select: { mustChangePassword: true, isPlatformAdmin: true },
          });
          if (fresh) {
            token.mustChangePassword = fresh.mustChangePassword;
            token.isPlatformAdmin = fresh.isPlatformAdmin;
          }
        }
      }

      // Periodically confirm the JWT org still exists and the user is still a member.
      // Fixes stale cookies after DB reseed / org deletion without a full sign-out loop.
      const due =
        !token.workspaceCheckedAt ||
        Date.now() - token.workspaceCheckedAt > WORKSPACE_RECHECK_MS;
      if (token.id && due) {
        const userRow = await prisma.user.findUnique({
          where: { id: token.id },
          select: { activeOrganisationId: true },
        });
        const preferred =
          token.organisationId || userRow?.activeOrganisationId || null;
        const resolved = await resolveActiveWorkspaceForUser({
          userId: token.id,
          preferredOrganisationId: preferred,
          persist: true,
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
