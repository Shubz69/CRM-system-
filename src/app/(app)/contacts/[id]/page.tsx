"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import { PageError, PageLoading } from "@/components/ui/page-state";

type Contact = {
  id: string;
  fullName: string | null;
  instagramUsername: string | null;
  email: string | null;
  phone: string | null;
  optedOut: boolean;
  leads: Array<{ score: number; qualificationStatus: string; stage?: { name: string } | null }>;
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
  const [contact, setContact] = useState<Contact | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setError(null);
    const response = await fetch(`/api/contacts/${id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load contact");
    setContact(data.contact);
  };

  useEffect(() => {
    setLoading(true);
    load()
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load contact"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function patch(body: Record<string, unknown>) {
    const response = await fetch(`/api/contacts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Update failed");
    await load();
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
            <button
              className={contact.optedOut ? "btn btn-secondary" : "btn btn-danger"}
              onClick={() =>
                patch({ optedOut: !contact.optedOut }).catch((e) => toast.error(e.message))
              }
            >
              {contact.optedOut ? "Clear opt-out" : "Opt out"}
            </button>
          </>
        }
      />
      <p className="font-[family-name:var(--font-fraunces)] text-2xl">
        {contact.fullName || "Unknown contact"}
      </p>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="surface p-5">
          <h2 className="font-semibold">Lead</h2>
          <p className="mt-2">
            Score <span className="badge badge-success">{lead?.score ?? 0}</span>
          </p>
          <p>
            {lead?.qualificationStatus || "No lead"} · {lead?.stage?.name || "No stage"}
          </p>
          <div className="mt-3 flex flex-wrap gap-1">
            {contact.tags.map(({ tag }) => (
              <span key={tag.id} className="badge" style={{ borderColor: tag.color }}>
                {tag.name}
              </span>
            ))}
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
    </div>
  );
}
