"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { BulkActions } from "@/components/contacts/bulk-actions";
import { canManageContacts, canWriteContacts } from "@/components/contacts/contact-permissions";
import { errorText, fetchTags, type TagSummary } from "@/components/contacts/contacts-api";
import { ImportPanel } from "@/components/contacts/import-panel";
import { TagChip } from "@/components/contacts/tag-chip";
import { TagManager } from "@/components/contacts/tag-manager";
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
  tags?: Array<{ tag: { id: string; name: string; color: string } }>;
  _count: { conversations: number; bookings: number };
};

function contactsUrl(query: string, tagId: string, offset?: number) {
  const params = new URLSearchParams({ q: query });
  if (tagId) params.set("tagId", tagId);
  if (offset) params.set("offset", String(offset));
  return `/api/contacts?${params.toString()}`;
}

export default function ContactsPage() {
  const workspaceContext = getImmutableWorkspaceContext(null);
  const workspaceReady = useWorkspaceReady();
  const { data: session } = useSession();
  const role = session?.user?.role ?? null;
  // Unknown role (session still loading): show the write actions; the server enforces permissions.
  const canWrite = role ? canWriteContacts(role) : true;
  // Merge, bulk delete / opt-out, editing tags workspace-wide, import that updates contacts.
  const canManage = role ? canManageContacts(role) : false;
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [q, setQ] = useState("");
  /** Search the loaded pages were drawn from — "Load more" keeps using it. */
  const [loadedQuery, setLoadedQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [loadedTagFilter, setLoadedTagFilter] = useState("");
  const [tags, setTags] = useState<TagSummary[]>([]);
  const [tagsState, setTagsState] = useState<"loading" | "ready" | "error">("loading");
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Bumps on every fresh load so a slow "Load more" never appends to a newer search. */
  const listSeqRef = useRef(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  /** Reload the workspace tags; returns them (null when loading failed). */
  const loadTags = useCallback(async (): Promise<TagSummary[] | null> => {
    try {
      setTagsError(null);
      const next = await fetchTags();
      setTags(next);
      setTagsState("ready");
      return next;
    } catch (err) {
      setTagsError(errorText(err, "Could not load tags"));
      setTagsState("error");
      return null;
    }
  }, []);

  async function load(query = q, tagId = tagFilter) {
    listSeqRef.current += 1;
    setListState("loading");
    setSelected(new Set());
    const res = await fetch(contactsUrl(query, tagId));
    const json = await res.json();
    if (!res.ok) {
      setListState("error");
      throw new Error(json.error || "Failed");
    }
    setContacts(json.contacts ?? []);
    setLoadedQuery(query);
    setLoadedTagFilter(tagId);
    setTotal(typeof json.total === "number" ? json.total : (json.contacts ?? []).length);
    setNextOffset(typeof json.nextOffset === "number" ? json.nextOffset : null);
    setListState("ready");
  }

  async function loadMore() {
    if (nextOffset == null || loadingMore) return;
    setLoadingMore(true);
    const seq = listSeqRef.current;
    try {
      const res = await fetch(contactsUrl(loadedQuery, loadedTagFilter, nextOffset));
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load more contacts");
      if (seq !== listSeqRef.current) return;
      const page = (json.contacts ?? []) as Contact[];
      setContacts((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...page.filter((c) => !seen.has(c.id))];
      });
      if (typeof json.total === "number") setTotal(json.total);
      setNextOffset(typeof json.nextOffset === "number" ? json.nextOffset : null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load more contacts");
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    void load("", "").catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load contacts"));
    void loadTags();
    // initial load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reloadList() {
    return load(loadedQuery, loadedTagFilter).catch((err) =>
      toast.error(err instanceof Error ? err.message : "Failed to load contacts"),
    );
  }

  /** After tags change: if the tag being filtered on is gone, drop the filter instead of
   *  showing "No contacts match". */
  async function reloadAfterTagChange() {
    const fresh = await loadTags();
    const filterGone = Boolean(fresh && loadedTagFilter && !fresh.some((t) => t.id === loadedTagFilter));
    if (filterGone) {
      setTagFilter("");
      await load(loadedQuery, "").catch((err) =>
        toast.error(err instanceof Error ? err.message : "Failed to load contacts"),
      );
      return;
    }
    if (fresh && tagFilter && !fresh.some((t) => t.id === tagFilter)) setTagFilter("");
    await reloadList();
  }

  const pageIds = contacts.map((c) => c.id);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPageSelected = pageIds.some((id) => selected.has(id));

  function toggleAll() {
    setSelected(allOnPageSelected ? new Set() : new Set(pageIds));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
      await load("", tagFilter);
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
              <select
                className="input w-40"
                value={tagFilter}
                aria-label="Filter by tag"
                disabled={tagsState === "loading"}
                onChange={(e) => {
                  setTagFilter(e.target.value);
                  load(q, e.target.value).catch((err) => toast.error(err.message));
                }}
              >
                <option value="">{tagsState === "error" ? "Tags unavailable" : "All tags"}</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name} ({(tag.contactCount ?? 0).toLocaleString()})
                  </option>
                ))}
              </select>
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
            {canWrite ? (
              <button className="btn btn-secondary" type="button" onClick={() => setImportOpen(true)}>
                Import CSV
              </button>
            ) : null}
            <a
              className="btn btn-secondary"
              href={`/api/contacts/export?q=${encodeURIComponent(q)}${tagFilter ? `&tagId=${encodeURIComponent(tagFilter)}` : ""}`}
            >
              Export CSV
            </a>
            <button className="btn btn-secondary" type="button" onClick={() => setTagsOpen(true)}>
              Tags
            </button>
          </>
        }
      />

      <BulkActions
        selectedIds={[...selected]}
        tags={tags}
        canWrite={canWrite}
        canManage={canManage}
        onClear={() => setSelected(new Set())}
        onDone={async (action) => {
          setSelected(new Set());
          await reloadList();
          if (action === "add_tag" || action === "remove_tag" || action === "delete") void loadTags();
        }}
      />

      <div className="surface overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-10">
                <input
                  type="checkbox"
                  aria-label="Select all contacts on this page"
                  checked={allOnPageSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someOnPageSelected && !allOnPageSelected;
                  }}
                  disabled={listState !== "ready" || contacts.length === 0}
                  onChange={toggleAll}
                />
              </th>
              <th>Name</th>
              <th>Source</th>
              <th>Score</th>
              <th>Stage</th>
              <th>Activity</th>
              <th>Consent</th>
            </tr>
          </thead>
          <tbody>
            {listState === "loading" && (
              <tr>
                <td colSpan={7} className="p-6 text-sm text-[var(--muted)]">
                  Loading contacts…
                </td>
              </tr>
            )}
            {listState === "error" && (
              <tr>
                <td colSpan={7} className="p-6 text-sm text-[var(--danger)]">
                  Could not load contacts. Try again.
                </td>
              </tr>
            )}
            {listState === "ready" && contacts.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <div className="p-4">
                    {loadedQuery || loadedTagFilter ? (
                      <p className="text-sm text-[var(--muted)]">No contacts match this search or tag.</p>
                    ) : (
                    <EmptyState
                      title="No contacts yet"
                      body="Add a person you met, import a CSV, or connect social accounts so inbound conversations appear here."
                      actions={[
                        { href: "/integrations", label: "Connect social accounts" },
                        { href: "/growth/prospecting", label: "Find prospects" },
                      ]}
                    />
                    )}
                  </div>
                </td>
              </tr>
            )}
            {listState === "ready" &&
              contacts.map((c) => (
              <tr key={c.id} className="cursor-pointer">
                <td className="w-10">
                  <input
                    type="checkbox"
                    aria-label={`Select ${c.fullName || "contact"}`}
                    checked={selected.has(c.id)}
                    onChange={() => toggleOne(c.id)}
                  />
                </td>
                <td>
                  <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">{c.fullName || "Unknown"}</Link>
                  <div className="meta">
                    @{c.instagramUsername || "—"} · {c.email || "no email"}
                  </div>
                  {c.tags?.length ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.tags.map(({ tag }) => (
                        <TagChip key={tag.id} name={tag.name} color={tag.color} />
                      ))}
                    </div>
                  ) : null}
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
        {listState === "ready" && contacts.length > 0 && nextOffset != null ? (
          <div className="flex items-center justify-between gap-2 p-3">
            <span className="meta">
              Showing {contacts.length.toLocaleString()} of {total.toLocaleString()}
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        ) : null}
      </div>

      <SlideOver
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import contacts"
        description="Upload a CSV. You'll see a preview with errors and existing matches before anything is saved."
        wide
      >
        <ImportPanel
          canUpdateExisting={canManage}
          onImported={() => {
            void reloadList();
            void loadTags();
          }}
        />
      </SlideOver>

      <SlideOver
        open={tagsOpen}
        onClose={() => setTagsOpen(false)}
        title="Tags"
        description={
          canManage
            ? "Group contacts with tags. Renaming or recolouring updates every tagged contact."
            : "Group contacts with tags. Owners, administrators and managers can rename or delete them."
        }
      >
        <TagManager
          tags={tags}
          loading={tagsState === "loading"}
          error={tagsError}
          canWrite={canWrite}
          canManage={canManage}
          onChanged={reloadAfterTagChange}
        />
      </SlideOver>

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
