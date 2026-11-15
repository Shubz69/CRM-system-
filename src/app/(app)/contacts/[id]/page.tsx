"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { AddToPipeline } from "@/components/contacts/add-to-pipeline";
import { ContactDuplicates } from "@/components/contacts/contact-duplicates";
import { canManageContacts, canWriteContacts } from "@/components/contacts/contact-permissions";
import { ContactTags } from "@/components/contacts/contact-tags";
import { PageHeader } from "@/components/ui/page-header";
import { PageError, PageLoading } from "@/components/ui/page-state";
import { SlideOver } from "@/components/ui/slide-over";
import { Customer360Panel } from "@/components/crm/customer-360-panel";
import { ContactActivityTimeline } from "@/components/contact-activity-timeline";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";

type Contact = {
  id: string;
  fullName: string | null;
  instagramUsername: string | null;
  email: string | null;
  phone: string | null;
  optedOut: boolean;
  leads: Array<{
    id: string;
    score: number;
    qualificationStatus: string;
    stage?: { id: string; name: string } | null;
  }>;
  conversations: Array<{ id: string; lastMessagePreview: string | null; lastMessageAt: string | null }>;
  bookings: Array<{
    id: string;
    status: string;
    scheduledAt: string | null;
    bookingUrl: string | null;
  }>;
  notes: Array<{ id: string; body: string; createdAt: string; author?: { name: string | null } | null }>;
  tags: Array<{ tag: { id: string; name: string; color: string } }>;
  attributions: Array<{ id: string; source: string | null; medium: string | null }>;
};

export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const workspaceContext = getImmutableWorkspaceContext(null);
  const { data: session } = useSession();
  const role = session?.user?.role ?? null;
  // Unknown role (session still loading): show write actions; the server enforces permissions.
  const canWrite = role ? canWriteContacts(role) : true;
  const canMerge = role ? canManageContacts(role) : false;
  const [contact, setContact] = useState<Contact | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    setError(null);
    const response = await fetch(`/api/contacts/${id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load contact");
    setContact(data.contact);
  };

  // Bumped after any change on this page so the activity timeline shows it immediately.
  const [activityKey, setActivityKey] = useState(0);

  /** Re-read the contact after a change made by a child panel (tags, pipeline, merge). */
  const reload = async () => {
    try {
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not refresh the contact");
    } finally {
      setActivityKey((k) => k + 1);
    }
  };

  useEffect(() => {
    setLoading(true);
    load()
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load contact"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function patch(body: Record<string, unknown>) {
    const response = await workspaceFetch(
      workspaceContext.loadedOrganisationId,
      workspaceContext.workspaceRevision,
      `/api/contacts/${id}`,
      {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Update failed");
  }

  function openEdit() {
    if (!contact) return;
    setEditName(contact.fullName || "");
    setEditEmail(contact.email || "");
    setEditPhone(contact.phone || "");
    setEditOpen(true);
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await patch({
        ...(editName.trim() ? { fullName: editName.trim() } : {}),
        email: editEmail.trim() || null,
        phone: editPhone.trim() || null,
      });
      await load();
      toast.success("Contact updated");
      setEditOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (deleting) return;
    if (
      !window.confirm(
        "Delete this contact? Their conversations, leads and deals will no longer appear in the inbox, pipeline or reports.",
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      await patch({ deleted: true });
      toast.success("Contact deleted");
      router.push("/contacts");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  }

  if (loading) return <PageLoading label="Loading contact" />;
  if (error || !contact) {
    return <PageError message={error || "Contact not found"} onRetry={() => void load()} />;
  }

  const lead = contact.leads[0];

  return (
    <div className="space-y-5">
      <PageHeader
        description={`@${contact.instagramUsername || "—"} · ${contact.email || "No email"} · ${contact.phone || "No phone"}`}
        actions={
          <>
            <Link className="btn btn-secondary" href="/contacts">
              Back to contacts
            </Link>
            <button className="btn btn-secondary" type="button" onClick={openEdit}>
              Edit
            </button>
            <button
              className={contact.optedOut ? "btn btn-secondary" : "btn btn-danger"}
              onClick={() =>
                patch({ optedOut: !contact.optedOut })
                  .then(load)
                  .catch((e) => toast.error(e.message))
              }
            >
              {contact.optedOut ? "Clear opt-out" : "Opt out"}
            </button>
            <button className="btn btn-danger" type="button" disabled={deleting} onClick={() => void onDelete()}>
              {deleting ? "Deleting…" : "Delete contact"}
            </button>
          </>
        }
      />
      <p className="font-[family-name:var(--font-fraunces)] text-2xl">
        {contact.fullName || "Unknown contact"}
      </p>

      <ContactDuplicates
        contactId={contact.id}
        contactName={contact.fullName || "this contact"}
        canMerge={canMerge}
        onMerged={reload}
      />

      <Customer360Panel contactId={contact.id} />

      <ContactActivityTimeline contactId={contact.id} refreshKey={activityKey} />

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="surface p-5">
          <h2 className="font-semibold">Lead</h2>
          {lead ? (
            <>
              <p className="mt-2">
                Score <span className="badge badge-success">{lead.score ?? 0}</span>
              </p>
              <p className="mb-2">{lead.qualificationStatus}</p>
            </>
          ) : null}
          <div className="mt-2">
            <AddToPipeline
              contactId={contact.id}
              lead={lead}
              canWrite={canWrite}
              onChanged={reload}
            />
          </div>
          <h3 className="caption mt-4">Tags</h3>
          <div className="mt-2">
            <ContactTags
              contactId={contact.id}
              tags={contact.tags.map(({ tag }) => tag)}
              canWrite={canWrite}
              onChanged={reload}
            />
          </div>
        </section>
        <section className="surface p-5 lg:col-span-2">
          <h2 className="font-semibold">Attribution</h2>
          {contact.attributions.length ? (
            contact.attributions.map((item) => (
              <p key={item.id}>
                {item.source || "Unknown"} · {item.medium || "—"}
              </p>
            ))
          ) : (
            <p className="text-[var(--muted)]">No attribution recorded.</p>
          )}
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="surface p-5">
          <h2 className="font-semibold">Recent conversations</h2>
          <ul className="mt-3 space-y-2">
            {contact.conversations.map((conversation) => (
              <li key={conversation.id}>
                <Link
                  className="block rounded-xl bg-[var(--surface-2)] p-3"
                  href={`/inbox?c=${conversation.id}`}
                >
                  {conversation.lastMessagePreview || "Open conversation"}
                </Link>
              </li>
            ))}
            {!contact.conversations.length && (
              <li className="text-[var(--muted)]">No conversations.</li>
            )}
          </ul>
        </section>
        <section className="surface p-5">
          <h2 className="font-semibold">Bookings</h2>
          <ul className="mt-3 space-y-2">
            {contact.bookings.map((booking) => (
              <li key={booking.id}>
                {booking.status} ·{" "}
                {booking.scheduledAt ? new Date(booking.scheduledAt).toLocaleString() : "Unscheduled"}
                {booking.bookingUrl && (
                  <a className="ml-2 text-[var(--accent)] underline" href={booking.bookingUrl}>
                    Open
                  </a>
                )}
              </li>
            ))}
            {!contact.bookings.length && <li className="text-[var(--muted)]">No bookings.</li>}
          </ul>
        </section>
      </div>

      <section className="surface p-5">
        <h2 className="font-semibold">Notes</h2>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (note.trim()) {
              patch({ note })
                .then(() => setNote(""))
                .then(reload)
                .catch((e) => toast.error(e.message));
            }
          }}
        >
          <label className="flex-1 text-sm">
            Internal note
            <textarea
              className="input mt-1 min-h-20"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button className="btn btn-primary self-end" type="submit">
            Add note
          </button>
        </form>
        <ul className="mt-4 space-y-2">
          {contact.notes.map((item) => (
            <li key={item.id} className="rounded-xl bg-[var(--surface-2)] p-3">
              <p>{item.body}</p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                {item.author?.name || "Team member"} · {new Date(item.createdAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <SlideOver
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit contact"
        description="Leave email or phone empty to clear it — do not invent them."
      >
        <form className="space-y-4" onSubmit={onSaveEdit}>
          <label className="block text-sm font-medium">
            Full name
            <input
              className="input mt-1 w-full"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              required
              maxLength={200}
              autoFocus
            />
          </label>
          <label className="block text-sm font-medium">
            Email
            <input
              className="input mt-1 w-full"
              type="email"
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
            />
          </label>
          <label className="block text-sm font-medium">
            Phone
            <input
              className="input mt-1 w-full"
              value={editPhone}
              onChange={(e) => setEditPhone(e.target.value)}
              maxLength={100}
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </form>
      </SlideOver>
    </div>
  );
}
