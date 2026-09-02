/**
 * READ-ONLY audit of organisations for launch QA cleanup decisions.
 *
 *   npx tsx scripts/audit-organisations.ts
 *
 * Never prints credentials/tokens. Never deletes anything.
 * Flags likely QA/test orgs by slug/name heuristics only.
 */
import "dotenv/config";
import { prisma } from "@/lib/db";

type Row = {
  organisationId: string;
  name: string;
  slug: string;
  createdAt: string;
  status: string;
  demoData: boolean;
  isPlatform: boolean;
  deletedAt: string | null;
  memberCount: number;
  contactCount: number;
  conversationCount: number;
  agentRunCount: number;
  likelyQaOrTest: boolean;
  qaReasons: string[];
};

function looksLikeQa(name: string, slug: string): { likely: boolean; reasons: string[] } {
  const hay = `${name} ${slug}`.toLowerCase();
  const reasons: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/\bqa\b/, "contains qa"],
    [/\btest\b/, "contains test"],
    [/\be2e\b/, "contains e2e"],
    [/\bci-/, "ci- prefix"],
    [/outbox-/, "outbox fixture"],
    [/mission-/, "mission fixture"],
    [/pred-/, "prediction fixture"],
    [/social-[ab]-/, "social isolation fixture"],
    [/agent-[ab]-/, "agent isolation fixture"],
    [/p1[34]-/, "phase isolation fixture"],
    [/inbound-/, "inbound fixture"],
    [/demo/, "demo marker"],
    [/acceptance/, "acceptance marker"],
  ];
  for (const [re, reason] of patterns) {
    if (re.test(hay)) reasons.push(reason);
  }
  return { likely: reasons.length > 0, reasons };
}

async function main() {
  const orgs = await prisma.organisation.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      status: true,
      demoData: true,
      isPlatform: true,
      deletedAt: true,
      _count: {
        select: {
          members: true,
          contacts: true,
          conversations: true,
          agentRuns: true,
        },
      },
    },
  });

  const rows: Row[] = orgs.map((o) => {
    const qa = looksLikeQa(o.name, o.slug);
    if (o.demoData) qa.reasons.push("demoData=true");
    return {
      organisationId: o.id,
      name: o.name,
      slug: o.slug,
      createdAt: o.createdAt.toISOString(),
      status: o.status,
      demoData: o.demoData,
      isPlatform: o.isPlatform,
      deletedAt: o.deletedAt ? o.deletedAt.toISOString() : null,
      memberCount: o._count.members,
      contactCount: o._count.contacts,
      conversationCount: o._count.conversations,
      agentRunCount: o._count.agentRuns,
      likelyQaOrTest: qa.likely || o.demoData,
      qaReasons: qa.reasons,
    };
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    totalOrganisations: rows.length,
    likelyQaOrTest: rows.filter((r) => r.likelyQaOrTest).length,
    platform: rows.filter((r) => r.isPlatform).length,
    softDeleted: rows.filter((r) => r.deletedAt).length,
    note: "READ-ONLY. Do not delete from this script. Use organisation-lifecycle purge with confirmSlug after human review.",
  };

  console.log(JSON.stringify({ summary, organisations: rows }, null, 2));
}

main()
  .catch((error) => {
    console.error("audit-organisations failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
