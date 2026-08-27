"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import { publishStatusMessage, statusLabel } from "@/lib/customer-labels";

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
};

type Connection = {
  id: string;
  platform: string;
  displayName: string | null;
  status: string;
};

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
  return `${statusLabel(job.status)} · ${statusLabel(job.externalOutcome)}`;
}

export default function ContentPage() {
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
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

  return (
    <div className="space-y-8">
      <PageHeader description="Content pieces and publishing jobs — never marked published without a real external id." />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Create draft piece</h2>
        <p className="text-sm text-muted-foreground">
          Requires a rationale and one http(s) source URL (whyEvidence).
        </p>
        <div className="flex flex-col gap-2 max-w-2xl">
          <input
            className="input"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="input min-h-[100px]"
            placeholder="Body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <input
            className="input"
            placeholder="Rationale (why this content)"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
          />
          <input
            className="input"
            placeholder="Source URL (https://…)"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
          />
          <input
            className="input"
            placeholder="Platform (optional)"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          />
          <button
            className="btn btn-primary w-fit"
            type="button"
            onClick={async () => {
              try {
                await postAction({
                  action: "create_draft_piece",
                  title,
                  body,
                  rationale,
                  sourceUrl,
                  platform: platform || undefined,
                });
                toast.success("Draft piece created");
                setTitle("");
                setBody("");
                setRationale("");
                setSourceUrl("");
                await load();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Failed");
              }
            }}
          >
            Create draft
          </button>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Pieces</h2>
        {pieces.length === 0 ? (
          <p className="text-sm text-muted-foreground">No content pieces yet.</p>
        ) : (
          pieces.map((p) => (
            <div key={p.id} className="border border-border rounded-lg p-4 space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-medium">{p.title}</h3>
                <span className="text-xs uppercase tracking-wide">{p.status}</span>
              </div>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap line-clamp-4">
                {p.body}
              </p>
              {p.platform && (
                <p className="text-xs text-muted-foreground">Platform: {p.platform}</p>
              )}

              {p.publishingJobs.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Publishing jobs</h4>
                  <ul className="text-sm space-y-2">
                    {p.publishingJobs.map((j) => (
                      <li key={j.id} className="border border-border/60 rounded p-2 space-y-1">
                        <div className="flex flex-wrap justify-between gap-2">
                          <span className="font-mono text-xs">{j.platform}</span>
                          <span className="text-xs uppercase">{jobOutcomeLabel(j)}</span>
                        </div>
                        {j.externalPostId && (
                          <p className="text-xs">externalPostId: {j.externalPostId}</p>
                        )}
                        {j.externalUrl && (
                          <p className="text-xs">
                            <a
                              className="underline"
                              href={j.externalUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {j.externalUrl}
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
                          await load();
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : "Failed");
                        }
                      }}
                    >
                      Submit approval
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
                          toast.success("Piece approved");
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
                          toast.success("Returned to draft");
                          await load();
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : "Failed");
                        }
                      }}
                    >
                      Reject
                    </button>
                  </>
                )}
                {(p.status === "APPROVED" || p.status === "SCHEDULED") && (
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
                <div className="space-y-2 border-t border-border pt-3">
                  <input
                    className="input w-full"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                  />
                  <textarea
                    className="input w-full min-h-[80px]"
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
                <div className="space-y-2 border-t border-border pt-3">
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
                          const result = await postAction(payload);
                          toast.success(
                            `Publish requested — job ${result.status ?? "queued"} (not confirmed until external id)`,
                          );
                          setPublishPieceId(null);
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
            </div>
          ))
        )}
      </section>
    </div>
  );
}
