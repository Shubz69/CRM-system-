"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRightLeft,
  BadgeCheck,
  Briefcase,
  CalendarClock,
  CheckSquare,
  Circle,
  FileInput,
  GitMerge,
  MessageSquare,
  Phone,
  PlusCircle,
  StickyNote,
  Tag,
  UserPen,
  Users,
  type LucideIcon,
} from "lucide-react";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";
import { cn } from "@/lib/utils";
import type { TimelineItem } from "@/app/api/activity/_lib/timeline";

type ManualKind = "call" | "meeting" | "task" | "note";

const MANUAL_KINDS: Array<{ value: ManualKind; label: string; placeholder: string }> = [
  { value: "call", label: "Call", placeholder: "Called about pricing" },
  { value: "meeting", label: "Meeting", placeholder: "Intro meeting at the studio" },
  { value: "task", label: "Task", placeholder: "Send the price list" },
  { value: "note", label: "Note", placeholder: "Prefers mornings" },
];

const KIND_META: Record<string, { label: string; Icon: LucideIcon }> = {
  call: { label: "Call", Icon: Phone },
  meeting: { label: "Meeting", Icon: Users },
  task: { label: "Task", Icon: CheckSquare },
  note: { label: "Note", Icon: StickyNote },
  stage_changed: { label: "Stage", Icon: ArrowRightLeft },
  qualification_changed: { label: "Qualification", Icon: BadgeCheck },
  added_to_pipeline: { label: "Pipeline", Icon: PlusCircle },
  reply_sent: { label: "Reply", Icon: MessageSquare },
  booking: { label: "Booking", Icon: CalendarClock },
  deal_created: { label: "Deal", Icon: Briefcase },
  deal_updated: { label: "Deal", Icon: Briefcase },
  tagged: { label: "Tags", Icon: Tag },
  imported: { label: "Import", Icon: FileInput },
  merged: { label: "Merge", Icon: GitMerge },
  contact_updated: { label: "Contact", Icon: UserPen },
};

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function relativeTime(iso: string, now: number): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return relativeFormat.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relativeFormat.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86_400) return relativeFormat.format(Math.round(seconds / 86_400), "day");
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: new Date(iso).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorText(json: Record<string, unknown>, fallback: string): string {
  return typeof json.error === "string" && json.error ? json.error : fallback;
}

/**
 * A contact's activity history with a "Log activity" form. Fetches its own data; bump
 * `refreshKey` after an action elsewhere on the page (merge, tags, add to pipeline) so the
 * new entries show without pressing Refresh.
 */
export function ContactActivityTimeline({
  contactId,
  refreshKey = 0,
}: {
  contactId: string;
  refreshKey?: number;
}) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingTasks, setPendingTasks] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());

  const [kind, setKind] = useState<ManualKind>("call");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Ignore responses for a contact we've since navigated away from.
  const requestSeq = useRef(0);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const params = new URLSearchParams({ contactId });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`/api/activity?${params.toString()}`, { cache: "no-store" });
      const json = await readJson(res);
      if (!res.ok) throw new Error(errorText(json, "Couldn't load activity"));
      return json as unknown as { items: TimelineItem[]; nextCursor: string | null; canWrite?: boolean };
    },
    [contactId],
  );

  const loadFirstPage = useCallback(async () => {
    const seq = ++requestSeq.current;
    setStatus("loading");
    setLoadError(null);
    try {
      const page = await fetchPage(null);
      if (seq !== requestSeq.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setCanWrite(Boolean(page.canWrite));
      setStatus("ready");
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setLoadError(error instanceof Error ? error.message : "Couldn't load activity");
      setStatus("error");
    }
  }, [fetchPage]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage, refreshKey]);

  // Keep "5 minutes ago" and overdue highlighting current.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const page = await fetchPage(nextCursor);
      if (seq !== requestSeq.current) return;
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't load more activity");
    } finally {
      setLoadingMore(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !title.trim()) return;
    let dueIso: string | null = null;
    if (kind === "task" && dueAt) {
      const parsed = new Date(dueAt);
      if (Number.isNaN(parsed.getTime())) {
        toast.error("Due date isn't a valid date");
        return;
      }
      dueIso = parsed.toISOString();
    }
    setSubmitting(true);
    try {
      const ctx = getImmutableWorkspaceContext(null);
      const res = await workspaceFetch(ctx.loadedOrganisationId, ctx.workspaceRevision, "/api/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId,
          kind,
          title: title.trim(),
          body: notes.trim() || null,
          dueAt: dueIso,
        }),
      });
      const json = await readJson(res);
      if (!res.ok) {
        toast.error(errorText(json, "Couldn't log the activity"));
        return;
      }
      const item = json.item as TimelineItem | undefined;
      if (item) setItems((prev) => [item, ...prev.filter((i) => i.id !== item.id)]);
      setNow(Date.now());
      setTitle("");
      setNotes("");
      setDueAt("");
      toast.success(`${KIND_META[kind]?.label ?? "Activity"} logged`);
    } catch {
      toast.error("Couldn't log the activity — check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleTask(item: TimelineItem, completed: boolean) {
    if (pendingTasks.has(item.id)) return;
    setPendingTasks((prev) => new Set(prev).add(item.id));
    try {
      const ctx = getImmutableWorkspaceContext(null);
      const res = await workspaceFetch(
        ctx.loadedOrganisationId,
        ctx.workspaceRevision,
        `/api/activity/${encodeURIComponent(item.sourceId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ completed }),
        },
      );
      const json = await readJson(res);
      if (!res.ok) {
        toast.error(errorText(json, "Couldn't update the task"));
        return;
      }
      const completedAt = typeof json.completedAt === "string" ? json.completedAt : null;
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, completedAt } : i)));
      toast.success(completed ? "Task done" : "Task reopened");
    } catch {
      toast.error("Couldn't update the task — check your connection and try again.");
    } finally {
      setPendingTasks((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  }

  const placeholder = MANUAL_KINDS.find((k) => k.value === kind)?.placeholder ?? "";

  return (
    <section className="surface space-y-4 p-4" aria-label="Activity timeline">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Activity</h2>
        {status === "ready" ? (
          <button
            type="button"
            className="btn btn-secondary px-2.5 py-1 text-xs"
            onClick={() => void loadFirstPage()}
          >
            Refresh
          </button>
        ) : null}
      </div>

      {canWrite ? (
        <form
          className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
          onSubmit={submit}
          aria-label="Log activity"
        >
          <p className="text-sm font-medium">Log activity</p>
          {/* `.input` is width:100%, so the row is sized by these wrappers. */}
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="sm:w-36 sm:flex-shrink-0">
              <label className="sr-only" htmlFor={`activity-kind-${contactId}`}>
                Activity type
              </label>
              <select
                id={`activity-kind-${contactId}`}
                className="input"
                value={kind}
                onChange={(e) => setKind(e.target.value as ManualKind)}
                disabled={submitting}
              >
                {MANUAL_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0 flex-1">
              <label className="sr-only" htmlFor={`activity-title-${contactId}`}>
                Title
              </label>
              <input
                id={`activity-title-${contactId}`}
                className="input"
                placeholder={placeholder}
                value={title}
                maxLength={300}
                onChange={(e) => setTitle(e.target.value)}
                disabled={submitting}
                required
              />
            </div>
          </div>
          <label className="sr-only" htmlFor={`activity-notes-${contactId}`}>
            Notes
          </label>
          <textarea
            id={`activity-notes-${contactId}`}
            className="input min-h-[64px] w-full"
            placeholder="Notes (optional)"
            value={notes}
            maxLength={10_000}
            onChange={(e) => setNotes(e.target.value)}
            disabled={submitting}
          />
          <div className="flex flex-wrap items-end justify-between gap-2">
            {kind === "task" ? (
              <label className="text-xs text-[var(--muted)]">
                Due (optional)
                <input
                  type="datetime-local"
                  className="input mt-1 block"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                  disabled={submitting}
                />
              </label>
            ) : (
              <span />
            )}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting || !title.trim()}
            >
              {submitting ? "Saving…" : "Log activity"}
            </button>
          </div>
        </form>
      ) : null}

      {status === "loading" ? (
        <div className="space-y-2" role="status" aria-live="polite">
          <span className="sr-only">Loading activity</span>
          <div className="skeleton h-12 w-full" />
          <div className="skeleton h-12 w-full" />
          <div className="skeleton h-12 w-full" />
        </div>
      ) : status === "error" ? (
        <div className="rounded-xl border border-[var(--border)] p-3" role="alert">
          <p className="text-sm">{loadError || "Couldn't load activity."}</p>
          <button
            type="button"
            className="btn btn-secondary mt-2"
            onClick={() => void loadFirstPage()}
          >
            Try again
          </button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">
          No activity yet.
          {canWrite ? " Log a call, meeting, task or note to start this contact's history." : ""}
        </p>
      ) : (
        <ol className="space-y-2">
          {items.map((item) => {
            const meta = KIND_META[item.kind] ?? { label: "Activity", Icon: Circle };
            const Icon = meta.Icon;
            const isTask = item.source === "activity" && item.kind === "task";
            const done = Boolean(item.completedAt);
            const overdue =
              isTask && !done && item.dueAt !== null && new Date(item.dueAt).getTime() < now;
            const pending = pendingTasks.has(item.id);
            const scheduledAt =
              item.kind === "booking" && typeof item.metadata.scheduledAt === "string"
                ? item.metadata.scheduledAt
                : null;
            return (
              <li
                key={item.id}
                className={cn(
                  "flex gap-3 rounded-xl border bg-[var(--surface)] p-3",
                  overdue ? "border-[var(--danger)]" : "border-[var(--border)]",
                )}
              >
                <span
                  className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]"
                  aria-hidden="true"
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {isTask && canWrite ? (
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={done}
                        disabled={pending}
                        onChange={(e) => void toggleTask(item, e.target.checked)}
                        aria-label={done ? `Mark "${item.title}" not done` : `Mark "${item.title}" done`}
                      />
                    ) : null}
                    <span
                      className={cn(
                        "font-medium break-words",
                        isTask && done && "text-[var(--muted)] line-through",
                      )}
                    >
                      {item.title}
                    </span>
                    <span className="badge">{meta.label}</span>
                    {isTask && done ? <span className="badge badge-success">Done</span> : null}
                    {overdue ? <span className="badge badge-danger">Overdue</span> : null}
                  </div>
                  {item.body ? (
                    <p className="mt-1 text-sm whitespace-pre-wrap break-words text-[var(--foreground)]">
                      {item.body}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    <time dateTime={item.occurredAt} title={formatDateTime(item.occurredAt)}>
                      {relativeTime(item.occurredAt, now)}
                    </time>
                    {item.createdBy ? <> · {item.createdBy.name}</> : null}
                    {isTask && item.dueAt ? <> · Due {formatDateTime(item.dueAt)}</> : null}
                    {scheduledAt ? <> · For {formatDateTime(scheduledAt)}</> : null}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {status === "ready" && nextCursor ? (
        <button
          type="button"
          className="btn btn-secondary w-full"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </section>
  );
}
