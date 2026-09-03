"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatLeadSource } from "@/lib/lead-source";
import { SlideOver } from "@/components/ui/slide-over";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";
import { useWorkspaceReady } from "@/hooks/use-workspace-ready";

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
  const workspaceContext = getImmutableWorkspaceContext(null);
  const workspaceReady = useWorkspaceReady();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [q, setQ] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function load(query = q) {
    const res = await fetch(`/api/contacts?q=${encodeURIComponent(query)}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed");
    setContacts(json.contacts ?? []);
  }

  useEffect(() => {
    void load("").catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load contacts"));
    // initial load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await workspaceFetch(workspaceContext.loadedOrganisationId, workspaceContext.workspaceRevision, "/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName,
          email: email || undefined,
          phone: phone || undefined,
          jobTitle: jobTitle || undefined,
          companyName: companyName || undefined,
          notes: notes || undefined,
          leadSource: "manual",
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save contact");
      toast.success("Contact saved");
      setFullName("");
      setEmail("");
      setPhone("");
      setJobTitle("");
      setCompanyName("");
      setNotes("");
      setDrawerOpen(false);
      await load("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        description="People in this workspace — from Instagram, prospecting, or added by your team."
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
            <button
              className="btn btn-primary disabled:cursor-wait disabled:opacity-60"
              type="button"
              data-testid="add-contact"
              disabled={!workspaceReady}
              aria-disabled={!workspaceReady}
              onClick={() => setDrawerOpen(true)}
            >
              {workspaceReady ? "+ Add contact" : "Loading…"}
            </button>
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
                      body="Add a person you met, or connect social accounts so inbound conversations appear here."
                      actions={[
                        { href: "/integrations", label: "Connect social accounts" },
                        { href: "/growth/prospecting", label: "Find prospects" },
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

      <SlideOver
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Add contact"
        description="Name is required. Email and phone are optional — do not invent them."
      >
        <form className="space-y-4" onSubmit={onCreate}>
          <label className="block text-sm font-medium">
            Full name
            <input
              className="input mt-1 w-full"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="block text-sm font-medium">
            Job title
            <input className="input mt-1 w-full" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
          </label>
          <label className="block text-sm font-medium">
            Company
            <input
              className="input mt-1 w-full"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Optional — creates or matches an account"
            />
          </label>
          <label className="block text-sm font-medium">
            Email
            <input
              className="input mt-1 w-full"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="block text-sm font-medium">
            Phone
            <input className="input mt-1 w-full" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label className="block text-sm font-medium">
            Notes
            <textarea className="input mt-1 w-full" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save contact"}
          </button>
        </form>
      </SlideOver>
    </div>
  );
}
