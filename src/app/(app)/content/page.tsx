"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import { SlideOver } from "@/components/ui/slide-over";
import {
  contentBucket,
  publishStatusMessage,
  statusLabel,
} from "@/lib/customer-labels";

type PubJob = {
  id: string;
  status: string;
  platform: string;
  externalPostId: string | null;
  externalUrl: string | null;
  error: string | null;
  externalOutcome: string;
  scheduledAt: string | null;
  reconciliationNote: string | null;
};

type Piece = {
  id: string;
  title: string;
  body: string;
  status: string;
  platform: string | null;
  publishingJobs: PubJob[];
  brief?: {
    objective?: string | null;
    idea?: { title?: string | null; opportunity?: { title?: string | null } | null } | null;
  } | null;
};

type Connection = {
  id: string;
  platform: string;
  displayName: string | null;
  status: string;
};

const BUCKETS = [
  { id: "drafts" as const, title: "Drafts" },
  { id: "ready" as const, title: "Ready" },
  { id: "awaiting" as const, title: "Awaiting approval" },
  { id: "scheduled" as const, title: "Scheduled" },
  { id: "published" as const, title: "Published" },
  { id: "attention" as const, title: "Needs attention" },
];

function jobOutcomeLabel(job: PubJob): string {
  if (job.status === "RECONCILIATION_REQUIRED" || job.externalOutcome === "RECONCILIATION_REQUIRED") {
    return publishStatusMessage("RECONCILIATION_REQUIRED");
  }
  if (job.status === "PUBLISHED" || job.externalOutcome === "CONFIRMED") {
    if (!job.externalPostId && !job.externalUrl) {
      return "Marked published, but we could not confirm an external link yet";
    }
    return "Published";
  }
  return statusLabel(job.status);
}

function statusTone(status: string): string {
  const bucket = contentBucket(status);
  if (bucket === "published" || bucket === "ready") return "badge badge-success";
  if (bucket === "awaiting" || bucket === "scheduled") return "badge badge-warn";
  if (bucket === "attention") return "badge badge-danger";
  return "badge";
}

export default function ContentPage() {
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeBucket, setActiveBucket] = useState<(typeof BUCKETS)[number]["id"]>("drafts");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [rationale, setRationale] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [platform, setPlatform] = useState("instagram");
  const [editId, setEditId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [publishPieceId, setPublishPieceId] = useState<string | null>(null);
  const [publishPlatform, setPublishPlatform] = useState("instagram");
  const [publishConnectionId, setPublishConnectionId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [showAdvancedCreate, setShowAdvancedCreate] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/content");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load content");
    setPieces(json.pieces ?? []);
    setConnections(json.socialConnections ?? []);
  }, []);

  useEffect(() => {
    load().catch((e) => toast.error(e.message));
  }, [load]);

  async function postAction(payload: Record<string, unknown>) {
    const res = await fetch("/api/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Action failed");
    return json;
  }

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const b of BUCKETS) map[b.id] = 0;
    for (const p of pieces) {
      const key = contentBucket(p.status);
      map[key] = (map[key] ?? 0) + 1;
    }
    return map;
  }, [pieces]);

  const filtered = pieces.filter((p) => contentBucket(p.status) === activeBucket);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        description="Organise drafts through approval, schedule, and published results — failures stay in plain English."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setComposerOpen(true)}>
            + Create
          </button>
        }
      />

      <section className="space-y-4">
        <div className="filter-bar flex flex-wrap gap-2" role="tablist" aria-label="Content status">
          {BUCKETS.map((b) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={activeBucket === b.id}
              className={`badge ${activeBucket === b.id ? "badge-success" : ""}`}
              onClick={() => setActiveBucket(b.id)}
            >
              {b.title}
              <span className="ml-1 opacity-70">{counts[b.id] ?? 0}</span>
            </button>
          ))}
        </div>

        {pieces.length === 0 ? (
          <div className="surface-muted p-6">
            <p className="font-[family-name:var(--font-fraunces)] text-xl">No content yet</p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Create a draft to start the workspace, or turn research from Ask into an opportunity.
            </p>
            <button type="button" className="btn btn-primary mt-4" onClick={() => setComposerOpen(true)}>
              Create draft
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="surface p-6 text-sm text-[var(--muted)]">
            Nothing in {BUCKETS.find((b) => b.id === activeBucket)?.title ?? "this view"} yet.
          </div>
        ) : null}
      </section>

      <SlideOver
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        title="Create content"
        description="What are you creating? Platform and brief first — advanced fields are optional."
        wide
      >
        <div className="space-y-3">
          <label className="block text-sm font-medium">
            Title
            <input
              className="input mt-1 w-full"
              placeholder="What are you creating?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="block text-sm font-medium">
            Platform
            <input
              className="input mt-1 w-full"
              placeholder="e.g. Instagram"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            />
          </label>
          <label className="block text-sm font-medium">
            Brief / content
            <textarea
              className="input mt-1 min-h-[120px] w-full"
              placeholder="Draft the post or brief"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <details
            open={showAdvancedCreate}
            onToggle={(e) => setShowAdvancedCreate((e.target as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer text-sm font-medium text-[var(--muted)]">
              Advanced (rationale, source, goal)
            </summary>
            <div className="mt-3 space-y-3">
              <input
                className="input w-full"
                placeholder="Rationale (optional)"
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
              />
              <input
                className="input w-full"
                placeholder="Source URL (optional)"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
              />
            </div>
          </details>
          <button
            className="btn btn-primary"
            type="button"
            onClick={async () => {
              try {
                await postAction({
                  action: "create_draft_piece",
                  title,
                  body,
                  rationale: rationale || undefined,
                  sourceUrl: sourceUrl || undefined,
                  platform: platform || undefined,
                });
                toast.success("Draft created");
                setTitle("");
                setBody("");
                setRationale("");
                setSourceUrl("");
                setActiveBucket("drafts");
                setComposerOpen(false);
                await load();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Failed");
              }
            }}
          >
            Create draft
          </button>
        </div>
      </SlideOver>

      <div className="space-y-4">
        {pieces.length > 0 && filtered.length > 0
          ? filtered.map((p) => {
            const latestJob = p.publishingJobs[0];
            return (
              <article key={p.id} className="surface space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="font-medium">{p.title}</h3>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <span className={statusTone(p.status)}>{statusLabel(p.status)}</span>
                      {p.platform && (
                        <span className="badge">
                          {p.platform.charAt(0).toUpperCase() + p.platform.slice(1)}
                        </span>
                      )}
                      {(p.brief?.idea?.opportunity?.title || p.brief?.idea?.title) && (
                        <span className="badge">
                          {p.brief?.idea?.opportunity?.title || p.brief?.idea?.title}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <p className="line-clamp-3 whitespace-pre-wrap text-sm text-[var(--muted)]">
                  {p.body}
                </p>

                <dl className="grid gap-2 text-xs sm:grid-cols-2 md:grid-cols-4">
                  <div>
                    <dt className="text-[var(--muted)]">Platform</dt>
                    <dd className="font-medium">
                      {p.platform
                        ? p.platform.charAt(0).toUpperCase() + p.platform.slice(1)
                        : "Not set"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--muted)]">Approval</dt>
                    <dd className="font-medium">{statusLabel(p.status)}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--muted)]">Schedule</dt>
                    <dd className="font-medium">
                      {latestJob?.scheduledAt
                        ? new Date(latestJob.scheduledAt).toLocaleString()
                        : "Not scheduled"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--muted)]">Publish result</dt>
                    <dd className="font-medium">
                      {latestJob ? jobOutcomeLabel(latestJob) : "Not published"}
                    </dd>
                  </div>
                </dl>

                {p.publishingJobs.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium">Publishing activity</h4>
                    <ul className="space-y-2 text-sm">
                      {p.publishingJobs.map((j) => (
                        <li key={j.id} className="rounded-lg border border-[var(--border)] p-2 space-y-1">
                          <div className="flex flex-wrap justify-between gap-2">
                            <span className="badge">{j.platform}</span>
                            <span className="text-xs">{jobOutcomeLabel(j)}</span>
                          </div>
                          {j.externalUrl && (
                            <p className="text-xs">
                              <a className="underline" href={j.externalUrl} target="_blank" rel="noreferrer">
                                View on platform
                              </a>
                            </p>
                          )}
                          {j.error && (
                            <p className="text-xs text-[var(--danger)]">
                              Could not publish: {j.error}
                            </p>
                          )}
                          {(j.status === "RECONCILIATION_REQUIRED" ||
                            j.externalOutcome === "RECONCILIATION_REQUIRED") && (
                            <p className="text-xs text-[var(--warn)]">
                              {publishStatusMessage("RECONCILIATION_REQUIRED")}
                              {j.reconciliationNote ? ` ${j.reconciliationNote}` : ""}
                            </p>
                          )}
                          {j.status === "FAILED" && (
                            <p className="text-xs text-[var(--danger)]">
                              Not published — review and retry when ready
                            </p>
                          )}
                          {!["PUBLISHED", "CANCELLED", "DISPATCHING"].includes(j.status) &&
                            j.externalOutcome !== "CONFIRMED" && (
                              <button
                                className="btn btn-secondary text-xs"
                                type="button"
                                onClick={async () => {
                                  try {
                                    await postAction({
                                      action: "cancel_publish_job",
                                      jobId: j.id,
                                    });
                                    toast.success("Publish job cancelled");
                                    await load();
                                  } catch (e) {
                                    toast.error(e instanceof Error ? e.message : "Failed");
                                  }
                                }}
                              >
                                Cancel job
                              </button>
                            )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {p.status === "DRAFT" && (
                    <>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => {
                          setEditId(p.id);
                          setEditTitle(p.title);
                          setEditBody(p.body);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={async () => {
                          try {
                            await postAction({ action: "submit_approval", pieceId: p.id });
                            toast.success("Submitted for approval");
                            setActiveBucket("awaiting");
                            await load();
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Failed");
                          }
                        }}
                      >
                        Submit for approval
                      </button>
                    </>
                  )}
                  {p.status === "IN_REVIEW" && (
                    <>
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={async () => {
                          try {
                            await postAction({
                              action: "decide_approval",
                              pieceId: p.id,
                              decision: "APPROVED",
                            });
                            toast.success("Approved — ready to publish");
                            setActiveBucket("ready");
                            await load();
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Failed");
                          }
                        }}
                      >
                        Approve
                      </button>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={async () => {
                          try {
                            await postAction({
                              action: "decide_approval",
                              pieceId: p.id,
                              decision: "REJECTED",
                            });
                            toast.success("Returned to drafts");
                            setActiveBucket("drafts");
                            await load();
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Failed");
                          }
                        }}
                      >
                        Send back
                      </button>
                    </>
                  )}
                  {(p.status === "APPROVED" || p.status === "READY" || p.status === "SCHEDULED") && (
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={() => {
                        setPublishPieceId(p.id);
                        setPublishPlatform(p.platform || "instagram");
                        setPublishConnectionId("");
                        setScheduledAt("");
                      }}
                    >
                      Request publish
                    </button>
                  )}
                </div>

                {editId === p.id && (
                  <div className="space-y-2 border-t border-[var(--border)] pt-3">
                    <input
                      className="input w-full"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                    />
                    <textarea
                      className="input min-h-[80px] w-full"
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={async () => {
                          try {
                            await postAction({
                              action: "update_piece",
                              pieceId: p.id,
                              title: editTitle,
                              body: editBody,
                            });
                            toast.success("Piece updated");
                            setEditId(null);
                            await load();
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Failed");
                          }
                        }}
                      >
                        Save
                      </button>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => setEditId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {publishPieceId === p.id && (
                  <div className="space-y-2 border-t border-[var(--border)] pt-3">
                    <select
                      className="input"
                      value={publishPlatform}
                      onChange={(e) => setPublishPlatform(e.target.value)}
                    >
                      {["instagram", "linkedin", "tiktok", "youtube", "x", "facebook"].map(
                        (pl) => (
                          <option key={pl} value={pl}>
                            {pl}
                          </option>
                        ),
                      )}
                    </select>
                    <select
                      className="input"
                      value={publishConnectionId}
                      onChange={(e) => setPublishConnectionId(e.target.value)}
                    >
                      <option value="">No social connection</option>
                      {connections
                        .filter((c) => c.status === "ACTIVE")
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.platform}
                            {c.displayName ? ` · ${c.displayName}` : ""}
                          </option>
                        ))}
                    </select>
                    <input
                      className="input"
                      type="datetime-local"
                      value={scheduledAt}
                      onChange={(e) => setScheduledAt(e.target.value)}
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={async () => {
                          try {
                            const payload: Record<string, unknown> = {
                              action: scheduledAt ? "schedule_publish" : "request_publish",
                              pieceId: p.id,
                              platform: publishPlatform,
                              socialConnectionId: publishConnectionId || undefined,
                            };
                            if (scheduledAt) {
                              payload.scheduledAt = new Date(scheduledAt).toISOString();
                            }
                            await postAction(payload);
                            toast.success(
                              scheduledAt
                                ? "Scheduled — not live until the platform confirms"
                                : "Publish queued — not confirmed until the platform returns an id",
                            );
                            setPublishPieceId(null);
                            setActiveBucket(scheduledAt ? "scheduled" : "attention");
                            await load();
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Failed");
                          }
                        }}
                      >
                        {scheduledAt ? "Schedule" : "Queue publish"}
                      </button>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => setPublishPieceId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })
        : null}
      </div>
    </div>
  );
}
