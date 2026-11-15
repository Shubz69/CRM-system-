"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { errorText, fetchTags, sendJson, type TagSummary } from "./contacts-api";
import { TagChip } from "./tag-chip";

type ContactTag = { id: string; name: string; color: string };

/**
 * Tag chips on a contact with add (pick an existing tag or create one by typing) and remove.
 */
export function ContactTags({
  contactId,
  tags,
  canWrite,
  onChanged,
}: {
  contactId: string;
  tags: ContactTag[];
  canWrite: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [allTags, setAllTags] = useState<TagSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const onContact = useMemo(() => new Set(tags.map((t) => t.id)), [tags]);
  const trimmed = query.trim().replace(/\s+/g, " ");
  const suggestions = useMemo(
    () =>
      (allTags ?? [])
        .filter((t) => !onContact.has(t.id))
        .filter((t) => !trimmed || t.name.toLowerCase().includes(trimmed.toLowerCase()))
        .slice(0, 8),
    [allTags, onContact, trimmed],
  );
  const exact = (allTags ?? []).find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
  const alreadyOnContact = tags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase());

  async function openPicker() {
    setOpen(true);
    setQuery("");
    if (allTags) return;
    try {
      setLoadError(null);
      setAllTags(await fetchTags());
    } catch (error) {
      setLoadError(errorText(error, "Could not load tags"));
    }
  }

  async function add(body: { tagId: string } | { name: string }) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await sendJson<{ tag: TagSummary; tagCreated: boolean }>(
        `/api/contacts/${contactId}/tags`,
        "POST",
        body,
      );
      if (res.tagCreated) setAllTags((prev) => (prev ? [...prev, res.tag] : prev));
      toast.success(res.tagCreated ? `Created and added "${res.tag.name}"` : `Tagged "${res.tag.name}"`);
      setQuery("");
      await onChanged();
    } catch (error) {
      toast.error(errorText(error, "Could not add the tag"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(tag: ContactTag) {
    if (removingId) return;
    setRemovingId(tag.id);
    try {
      await sendJson(`/api/contacts/${contactId}/tags/${tag.id}`, "DELETE");
      await onChanged();
    } catch (error) {
      toast.error(errorText(error, "Could not remove the tag"));
    } finally {
      setRemovingId(null);
    }
  }

  function submitTyped() {
    if (!trimmed || alreadyOnContact) return;
    if (trimmed.length > 40) {
      toast.error("Tag names can be at most 40 characters.");
      return;
    }
    void add(exact ? { tagId: exact.id } : { name: trimmed });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <TagChip
            key={tag.id}
            name={tag.name}
            color={tag.color}
            removing={removingId === tag.id}
            onRemove={canWrite ? () => void remove(tag) : undefined}
          />
        ))}
        {!tags.length && !open ? <span className="text-sm text-[var(--muted)]">No tags.</span> : null}
        {canWrite && !open ? (
          <button
            type="button"
            className="rounded-md border border-dashed border-[var(--border)] px-2 py-0.5 text-xs font-semibold text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            onClick={() => void openPicker()}
          >
            + Tag
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitTyped();
            }}
          >
            <input
              className="input text-sm"
              placeholder="Find or create a tag"
              value={query}
              maxLength={60}
              autoFocus
              disabled={busy}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
              }}
              aria-label="Tag name"
            />
          </form>
          {loadError ? <p className="mt-2 text-xs text-[var(--danger)]">{loadError}</p> : null}
          {allTags === null && !loadError ? <p className="mt-2 text-xs text-[var(--muted)]">Loading tags…</p> : null}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {suggestions.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className="rounded-md disabled:opacity-50"
                disabled={busy}
                onClick={() => void add({ tagId: tag.id })}
                title={`Add ${tag.name}`}
              >
                <TagChip name={tag.name} color={tag.color} />
              </button>
            ))}
            {trimmed && !exact && !alreadyOnContact ? (
              <button
                type="button"
                className="btn btn-secondary px-2.5 py-1 text-xs"
                disabled={busy}
                onClick={submitTyped}
              >
                {busy ? "Adding…" : `Create "${trimmed}"`}
              </button>
            ) : null}
            {allTags !== null && !suggestions.length && !trimmed ? (
              <span className="text-xs text-[var(--muted)]">
                {allTags.length ? "No other tags — type a name to create one." : "Type a name to create the first tag."}
              </span>
            ) : null}
            {alreadyOnContact ? <span className="text-xs text-[var(--muted)]">Already tagged.</span> : null}
          </div>
          <div className="mt-2 text-right">
            <button type="button" className="text-xs font-semibold text-[var(--muted)] underline" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
