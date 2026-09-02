"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatLeadSource } from "@/lib/lead-source";

type Contact = {
  id: string;
  fullName: string | null;
  instagramUsername: string | null;
  email: string | null;
  phone: string | null;
  leadSource: string | null;
  campaignSource: string | null;
  lastContactAt: string;
  optedOut: boolean;
  leads: Array<{ score: number; qualificationStatus: string; stage?: { name: string } | null }>;
  _count: { conversations: number; bookings: number };
};

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [q, setQ] = useState("");

  async function load(query = q) {
    const res = await fetch(`/api/contacts?q=${encodeURIComponent(query)}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed");
    setContacts(json.contacts);
  }

  useEffect(() => {
    void load("");
    // initial load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader
        description="People who messaged your Instagram account."
        actions={
          <>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                load().catch((err) => toast.error(err.message));
              }}
            >
              <input
                className="input w-64"
                placeholder="Search name, @, email, phone"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <button className="btn btn-secondary" type="submit">
                Search
              </button>
            </form>
            <a className="btn btn-secondary" href={`/api/contacts/export?q=${encodeURIComponent(q)}`}>
              Export CSV
            </a>
          </>
        }
      />

      <div className="surface overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Source</th>
              <th>Score</th>
              <th>Stage</th>
              <th>Activity</th>
              <th>Consent</th>
            </tr>
          </thead>
          <tbody>
            {contacts.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <div className="p-4">
                    <EmptyState
                      title="No contacts yet"
                      body="People appear here after they message you on Instagram. Connect your account to start collecting leads."
                      actions={[
                        { href: "/integrations", label: "Connect Instagram", primary: true },
                        { href: "/settings/go-live", label: "Setup progress" },
                      ]}
                    />
                  </div>
                </td>
              </tr>
            )}
            {contacts.map((c) => (
              <tr key={c.id} className="cursor-pointer">
                <td>
                  <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">{c.fullName || "Unknown"}</Link>
                  <div className="meta">
                    @{c.instagramUsername || "—"} · {c.email || "no email"}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {formatLeadSource(c.leadSource)}
                  <div className="text-xs text-[var(--muted)]">{c.campaignSource}</div>
                </td>
                <td className="px-4 py-3">{c.leads[0]?.score ?? 0}</td>
                <td className="px-4 py-3">{c.leads[0]?.stage?.name || "—"}</td>
                <td className="px-4 py-3">
                  {c._count.conversations} conv · {c._count.bookings} bookings
                  <div className="text-xs text-[var(--muted)]">
                    Last {new Date(c.lastContactAt).toLocaleString()}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {c.optedOut ? (
                    <span className="badge badge-danger">Opted out</span>
                  ) : (
                    <span className="badge badge-success">OK</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
