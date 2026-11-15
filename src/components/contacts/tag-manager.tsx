"use client";

import { FormEvent, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "./confirm-dialog";
import { errorText, sendJson, type TagSummary } from "./contacts-api";
import { TAG_COLORS, TagChip } from "./tag-chip";

function ColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Tag colour">
      {TAG_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === color}
          aria-label={`Colour ${color}`}
          disabled={disabled}
          className={`h-5 w-5 rounded-full border-2 ${value.toLowerCase() === color ? "border-[var(--foreground)]" : "border-transparent"}`}
          style={{ background: color }}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}

/**
 * Workspace tags: create, rename, recolour, delete. `tags` comes from the parent so the
 * list-page filter and this panel stay in sync; `onChanged` reloads them. Creating needs
 * `canWrite`; renaming / recolouring / deleting (workspace-wide) needs `canManage`.
 */
export function TagManager({
  tags,
  loading,
  error,
  canWrite,
  canManage,
  onChanged,
}: {
  tags: TagSummary[];
  loading: boolean;
  error: string | null;
  canWrite: boolean;
  canManage: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(TAG_COLORS[0]!);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(TAG_COLORS[0]!);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TagSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (creating || !newName.trim()) return;
    setCreating(true);
    try {
      await sendJson("/api/tags", "POST", { name: newName, color: newColor });
      toast.success(`Created "${newName.trim()}"`);
      setNewName("");
      await onChanged();
    } catch (err) {
      toast.error(errorText(err, "Could not create the tag"));
    } finally {
      setCreating(false);
    }
  }

  function startEdit(tag: TagSummary) {
    setEditingId(tag.id);
    setEditName(tag.name);
    setEditColor(tag.color);
  }

  async function saveEdit(e: FormEvent, tag: TagSummary) {
    e.preventDefault();
    if (savingId) return;
    const body: Record<string, string> = {};
    if (editName.trim() !== tag.name) body.name = editName;
    if (editColor.toLowerCase() !== tag.color.toLowerCase()) body.color = editColor;
    if (!Object.keys(body).length) {
      setEditingId(null);
      return;
    }
    setSavingId(tag.id);
    try {
      await sendJson(`/api/tags/${tag.id}`, "PATCH", body);
      toast.success("Tag updated");
      setEditingId(null);
      await onChanged();
    } catch (err) {
      toast.error(errorText(err, "Could not update the tag"));
    } finally {
      setSavingId(null);
    }
  }

  async function confirmDelete() {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await sendJson(`/api/tags/${deleting.id}`, "DELETE");
      toast.success(`Deleted "${deleting.name}"`);
      setDeleting(null);
      await onChanged();
    } catch (err) {
      toast.error(errorText(err, "Could not delete the tag"));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {canWrite ? (
        <form className="space-y-2" onSubmit={create}>
          <label className="block text-sm font-medium">
            New tag
            <input
              className="input mt-1 w-full"
              value={newName}
              maxLength={40}
              placeholder="e.g. VIP, Wholesale, Follow up in May"
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
          <ColorPicker value={newColor} onChange={setNewColor} disabled={creating} />
          <button className="btn btn-primary" type="submit" disabled={creating || !newName.trim()}>
            {creating ? "Creating…" : "Create tag"}
          </button>
        </form>
      ) : null}

      <section>
        <h3 className="caption">Tags in this workspace</h3>
        {loading ? <p className="mt-2 text-sm text-[var(--muted)]">Loading tags…</p> : null}
        {error ? <p className="mt-2 text-sm text-[var(--danger)]">{error}</p> : null}
        {!loading && !error && tags.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--muted)]">No tags yet.</p>
        ) : null}
        <ul className="mt-2 space-y-2">
          {tags.map((tag) => (
            <li key={tag.id} className="rounded-xl bg-[var(--surface-2)] p-3">
              {editingId === tag.id ? (
                <form className="space-y-2" onSubmit={(e) => void saveEdit(e, tag)}>
                  <input
                    className="input py-1.5 text-sm"
                    value={editName}
                    maxLength={40}
                    autoFocus
                    aria-label="Tag name"
                    onChange={(e) => setEditName(e.target.value)}
                  />
                  <ColorPicker value={editColor} onChange={setEditColor} disabled={savingId === tag.id} />
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      className="btn btn-primary px-3 py-1.5 text-sm"
                      disabled={savingId === tag.id || !editName.trim()}
                    >
                      {savingId === tag.id ? "Saving…" : "Save"}
                    </button>
                    <button type="button" className="btn btn-secondary px-3 py-1.5 text-sm" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <TagChip name={tag.name} color={tag.color} />
                    <span className="meta">
                      {(tag.contactCount ?? 0).toLocaleString()} contact{tag.contactCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  {canManage ? (
                    <div className="flex gap-1">
                      <button type="button" className="btn btn-secondary px-2.5 py-1 text-xs" onClick={() => startEdit(tag)}>
                        Edit
                      </button>
                      <button type="button" className="btn btn-danger px-2.5 py-1 text-xs" onClick={() => setDeleting(tag)}>
                        Delete
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete tag?"
        confirmLabel="Delete tag"
        busyLabel="Deleting…"
        busy={deleteBusy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      >
        {deleting ? (
          <p>
            &ldquo;{deleting.name}&rdquo; will be removed from {(deleting.contactCount ?? 0).toLocaleString()} contact
            {deleting.contactCount === 1 ? "" : "s"} and any conversations. The contacts themselves are not changed.
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
