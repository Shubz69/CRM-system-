import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/db";
import { getAuthSecret, isDemoModeEnabled } from "@/lib/env";
import type { MemberRole } from "@prisma/client";

export type SessionMembership = {
  organisationId: string;
  organisationName: string;
  role: MemberRole;
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
  }
}

const DEMO_EMAIL = "demo@dminelligence.local";
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
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

        const memberships: SessionMembership[] = user.memberships.map((m) => ({
          organisationId: m.organisationId,
          organisationName: m.organisation.name,
          role: m.role,
        }));

        // Prefer SUPER_ADMIN membership when present
        const preferred =
          memberships.find((m) => m.role === "SUPER_ADMIN") ?? memberships[0];

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          organisationId: preferred?.organisationId,
          organisationName: preferred?.organisationName,
          role: preferred?.role,
          memberships,
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
      }

      if (trigger === "update" && session && typeof session === "object") {
        if ("mustChangePassword" in session && typeof session.mustChangePassword === "boolean") {
          token.mustChangePassword = session.mustChangePassword;
        }

        const nextOrgId =
          "organisationId" in session && typeof session.organisationId === "string"
            ? session.organisationId
            : undefined;
        if (nextOrgId && token.id) {
          const membership = await prisma.organisationMember.findUnique({
            where: {
              organisationId_userId: {
                organisationId: nextOrgId,
                userId: token.id,
              },
            },
            include: { organisation: true },
          });
          if (membership) {
            token.organisationId = membership.organisationId;
            token.organisationName = membership.organisation.name;
            token.role = membership.role;
            const all = await prisma.organisationMember.findMany({
              where: { userId: token.id },
              include: { organisation: true },
              orderBy: { createdAt: "asc" },
            });
            token.memberships = all.map((m) => ({
              organisationId: m.organisationId,
              organisationName: m.organisation.name,
              role: m.role,
            }));
          }
        }

        // Always re-read security flags from DB on session update to avoid stale JWT locks.
        if (token.id) {
          const fresh = await prisma.user.findUnique({
            where: { id: token.id },
            select: { mustChangePassword: true, isPlatformAdmin: true, isActive: true, isSuspended: true },
          });
          if (fresh) {
            token.mustChangePassword = fresh.mustChangePassword;
            token.isPlatformAdmin = fresh.isPlatformAdmin;
          }
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
