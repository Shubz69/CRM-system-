"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "./confirm-dialog";
import { errorText, getJson, sendJson } from "./contacts-api";

type Duplicate = {
  id: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  instagramUsername: string | null;
  leadSource: string | null;
  lastContactAt: string;
  matchedOn: Array<"email" | "phone" | "instagram">;
  counts: { conversations: number; leads: number; deals: number; notes: number; bookings: number };
};

const MATCH_LABEL = { email: "Same email", phone: "Same phone", instagram: "Same Instagram" } as const;

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function describeCounts(c: Duplicate["counts"]): string {
  const parts = [
    c.conversations ? plural(c.conversations, "conversation") : "",
    c.leads ? plural(c.leads, "pipeline lead") : "",
    c.deals ? plural(c.deals, "deal") : "",
    c.notes ? plural(c.notes, "note") : "",
    c.bookings ? plural(c.bookings, "booking") : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no conversations, leads, deals, notes or bookings";
}

/**
 * "Possible duplicates" on the contact page — same email, phone or Instagram handle — with
 * a confirmed Merge that folds the duplicate into this contact.
 */
export function ContactDuplicates({
  contactId,
  contactName,
  canMerge,
  onMerged,
}: {
  contactId: string;
  contactName: string;
  canMerge: boolean;
  onMerged: () => Promise<void> | void;
}) {
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Duplicate | null>(null);
  const [merging, setMerging] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const json = await getJson<{ duplicates: Duplicate[] }>(`/api/contacts/${contactId}/duplicates`);
      setDuplicates(json.duplicates ?? []);
    } catch (err) {
      setError(errorText(err, "Could not check for duplicates"));
    }
  }, [contactId]);

  useEffect(() => {
    setDuplicates(null);
    void load();
  }, [load]);

  async function merge() {
    if (!confirming || merging) return;
    setMerging(true);
    try {
      await sendJson(`/api/contacts/${contactId}/merge`, "POST", { duplicateId: confirming.id });
      toast.success(`Merged ${confirming.fullName || "the duplicate"} into ${contactName}`);
      setConfirming(null);
      await Promise.all([onMerged(), load()]);
    } catch (err) {
      toast.error(errorText(err, "Merge failed"));
    } finally {
      setMerging(false);
    }
  }

  // Nothing to show: keep the page quiet.
  if (duplicates && duplicates.length === 0 && !error) return null;

  return (
    <section className="surface-attention p-5" aria-labelledby="possible-duplicates-title">
      <h2 id="possible-duplicates-title" className="font-semibold">
        Possible duplicates
      </h2>
      {duplicates === null && !error ? (
        <p className="mt-2 text-sm text-[var(--muted)]">Checking for duplicates…</p>
      ) : null}
      {error ? (
        <p className="mt-2 text-sm text-[var(--danger)]">
          {error}{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : null}
      {duplicates && duplicates.length > 0 ? (
        <>
          <p className="mt-1 text-sm text-[var(--muted)]">
            These contacts share an email, phone number or Instagram handle with {contactName}.
          </p>
          <ul className="mt-3 space-y-2">
            {duplicates.map((dup) => (
              <li
                key={dup.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--surface)] p-3"
              >
                <div className="min-w-0">
                  <Link href={`/contacts/${dup.id}`} className="font-medium hover:underline">
                    {dup.fullName || "Unknown contact"}
                  </Link>
                  <div className="meta">
                    @{dup.instagramUsername || "—"} · {dup.email || "no email"} · {dup.phone || "no phone"}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {dup.matchedOn.map((m) => (
                      <span key={m} className="badge badge-warn">
                        {MATCH_LABEL[m]}
                      </span>
                    ))}
                    <span className="meta self-center">{describeCounts(dup.counts)}</span>
                  </div>
                </div>
                {canMerge ? (
                  <button
                    type="button"
                    className="btn btn-secondary px-3 py-1.5 text-sm"
                    disabled={merging}
                    onClick={() => setConfirming(dup)}
                  >
                    Merge into this contact
                  </button>
                ) : (
                  <span className="meta">Ask an owner or manager to merge.</span>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <ConfirmDialog
        open={Boolean(confirming)}
        title="Merge contacts?"
        confirmLabel="Merge contacts"
        busyLabel="Merging…"
        busy={merging}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void merge()}
      >
        {confirming ? (
          <>
            <p>
              <strong className="text-[var(--foreground)]">{confirming.fullName || "This duplicate"}</strong> will be
              merged into <strong className="text-[var(--foreground)]">{contactName}</strong>.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Moves {describeCounts(confirming.counts)} onto {contactName}.</li>
              <li>Also moves its tags, follow-ups, attribution, activity history and Instagram/channel identities.</li>
              <li>Empty details on {contactName} (email, phone, Instagram…) are filled in from the duplicate. Nothing already set is overwritten.</li>
              <li>The duplicate is then removed from your contacts. This can&apos;t be undone from the app.</li>
            </ul>
          </>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
