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
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    organisationId?: string;
    organisationName?: string;
    role?: MemberRole;
    memberships?: SessionMembership[];
  }
}

const DEMO_EMAIL = "demo@dminelligence.local";

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
        const valid = await compare(credentials.password, user.passwordHash);
        if (!valid) return null;

        const memberships: SessionMembership[] = user.memberships.map((m) => ({
          organisationId: m.organisationId,
          organisationName: m.organisation.name,
          role: m.role,
        }));
        const membership = memberships[0];

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          organisationId: membership?.organisationId,
          organisationName: membership?.organisationName,
          role: membership?.role,
          memberships,
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
      }

      if (trigger === "update" && session && typeof session === "object") {
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
            // Refresh memberships list
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
      }
      return session;
    },
  },
};
