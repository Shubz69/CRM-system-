"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";

type Detail = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  contacts: Array<{ id: string; fullName: string | null; email: string | null }>;
  deals: Array<{ id: string; name: string; status: string; amountCents: number | null }>;
  _count: { contacts: number; deals: number };
};

export default function CompanyDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = typeof params?.id === "string" ? params.id : "";
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    fetch(`/api/companies/${id}`)
      .then(async (res) => {
        const json = await res.json();
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(json.error || "Could not load company");
        setDetail(json.company);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4" role="status" aria-live="polite">
        <p className="text-sm text-[var(--muted)]">Loading company…</p>
      </div>
    );
  }

  if (notFound || !detail) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <PageHeader description="Company not found in this workspace." />
        <button type="button" className="btn btn-secondary" onClick={() => router.push("/companies")}>
          Back to companies
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        description={[detail.domain, detail.industry].filter(Boolean).join(" · ") || "Company detail"}
        actions={
          <Link className="btn btn-secondary" href="/companies">
            All companies
          </Link>
        }
      />
      <h1 className="font-[family-name:var(--font-fraunces)] text-3xl">{detail.name}</h1>

      <section className="surface space-y-3 p-5">
        <h2 className="font-medium">Contacts ({detail._count.contacts})</h2>
        {detail.contacts.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">None yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {detail.contacts.map((p) => (
              <li key={p.id}>
                <Link className="underline" href={`/contacts/${p.id}`}>
                  {p.fullName || "Unnamed"}
                </Link>
                {p.email ? ` · ${p.email}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="surface space-y-3 p-5">
        <h2 className="font-medium">Deals ({detail._count.deals})</h2>
        {detail.deals.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">None yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {detail.deals.map((d) => (
              <li key={d.id}>
                <Link className="underline" href="/deals">
                  {d.name}
                </Link>{" "}
                · {d.status}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
