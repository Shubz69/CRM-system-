"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { evaluateMessagingWindow, formatDurationRemaining } from "@/lib/messaging-window";

type ConversationListItem = {
  id: string;
  contactName: string | null;
  instagramUsername: string | null;
  unreadCount: number;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  handlingMode: string;
  aiPaused: boolean;
  needsHumanReview: boolean;
  messagingWindowExpiresAt?: string | null;
  humanMessagingWindowExpiresAt?: string | null;
  lastInboundAt?: string | null;
  lead: {
    id: string;
    score: number;
    qualificationStatus: string;
    stage: string | null;
    stageId: string | null;
  } | null;
};

type ConversationDetail = {
  id: string;
  summary: string | null;
  intent: string | null;
  sentiment: string | null;
  handlingMode: string;
  aiPaused: boolean;
  needsHumanReview: boolean;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  messagingWindowExpiresAt?: string | null;
  humanMessagingWindowExpiresAt?: string | null;
  contact: {
    id: string;
    fullName: string | null;
    instagramUsername: string | null;
    email: string | null;
    phone: string | null;
    leadSource: string | null;
    optedOut: boolean;
  };
  messages: Array<{
    id: string;
    body: string;
    senderType: string;
    direction: string;
    sentAt: string;
  }>;
  leads: Array<{
    id: string;
    score: number;
    scoreExplanation: string | null;
    qualificationStatus: string;
    stageId: string | null;
    stage?: { id: string; name: string } | null;
    bookings: Array<{ id: string; status: string; bookingUrl: string | null }>;
    scoreEvents?: Array<{
      id: string;
      previousScore: number;
      newScore: number;
      delta: number;
      reason: string;
      createdAt: string;
    }>;
  }>;
  objections: Array<{ id: string; category: string; text: string }>;
  questions: Array<{ id: string; text: string }>;
  buyingSignals: Array<{ id: string; text: string }>;
  followUps: Array<{ id: string; status: string; scheduledFor: string; attemptNumber: number; cancelReason?: string | null }>;
  assignments?: Array<{ user: { id: string; name: string | null; email: string } }>;
};

type Stage = { id: string; name: string; slug: string };
type Member = { id: string; name: string | null; email: string; role: string };

export default function InboxPage() {
  const searchParams = useSearchParams();
  const [items, setItems] = useState<ConversationListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get("c"));
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [reply, setReply] = useState("");
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<Member[]>([]);
  const [note, setNote] = useState("");

  const loadList = useCallback(async () => {
    const res = await fetch("/api/conversations");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load inbox");
    setItems(json.conversations);
    setSelectedId((current) => current ?? json.conversations[0]?.id ?? null);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/conversations/${id}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load conversation");
    setDetail(json.conversation);
  }, []);

  useEffect(() => {
    Promise.all([
      loadList(),
      fetch("/api/pipeline")
        .then((r) => r.json())
        .then((j) => setStages(j.pipeline?.stages ?? [])),
      fetch("/api/members").then((r) => r.json()).then((j) => setMembers(j.members ?? [])),
    ])
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));

    const timer = setInterval(() => {
      loadList().catch(() => undefined);
    }, 8000);
    return () => clearInterval(timer);
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) return;
    loadDetail(selectedId).catch((e) => toast.error(e.message));
  }, [selectedId, loadDetail]);

  const lead = detail?.leads?.[0];

  const messagingWindow = useMemo(() => {
    if (!detail) return null;
    return evaluateMessagingWindow({
      lastInboundAt: detail.lastInboundAt ? new Date(detail.lastInboundAt) : null,
      messagingWindowExpiresAt: detail.messagingWindowExpiresAt
        ? new Date(detail.messagingWindowExpiresAt)
        : null,
      humanMessagingWindowExpiresAt: detail.humanMessagingWindowExpiresAt
        ? new Date(detail.humanMessagingWindowExpiresAt)
        : null,
      aiPaused: detail.aiPaused,
      handlingMode: detail.handlingMode,
      optedOut: detail.contact.optedOut,
    });
  }, [detail]);

  async function patch(body: Record<string, unknown>) {
    if (!selectedId) return;
    const res = await fetch(`/api/conversations/${selectedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Update failed");
      return;
    }
    toast.success("Updated");
    await Promise.all([loadList(), loadDetail(selectedId)]);
  }

  async function onReply(e: FormEvent) {
    e.preventDefault();
    if (!reply.trim()) return;
    await patch({ reply });
    setReply("");
  }

  const sorted = useMemo(
    () =>
      [...items].sort((a, b) => {
        const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
        const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
        return bt - at;
      }),
    [items],
  );

  if (loading) return <div className="surface p-6">Loading inbox…</div>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="h-display text-4xl">Inbox</h1>
        <p className="text-[var(--muted)]">Unified Instagram conversations with AI and human controls.</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[320px_1fr_300px]" style={{ minHeight: "70vh" }}>
        <section className="surface overflow-hidden">
          <div className="border-b border-[var(--border)] px-4 py-3 font-medium">Conversations</div>
          <div className="max-h-[70vh] overflow-y-auto">
            {sorted.length === 0 && (
              <div className="p-4">
                <p className="font-[family-name:var(--font-fraunces)] text-xl">No conversations yet</p>
                <p className="mt-2 text-sm text-[var(--muted)]">
                  Connect Instagram, or send a test DM to see how AI handles a real chat.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <a href="/settings/go-live" className="btn btn-primary">
                    Connect Instagram
                  </a>
                  <a href="/simulator" className="btn btn-secondary">
                    Send a test DM
                  </a>
                </div>
              </div>
            )}
            {sorted.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedId(c.id)}
                className={`block w-full border-b border-[var(--border)] px-4 py-3 text-left hover:bg-[var(--surface-2)] ${
                  selectedId === c.id ? "bg-[var(--accent-soft)]" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{c.contactName || "Unknown"}</span>
                  {c.unreadCount > 0 && <span className="badge badge-success">{c.unreadCount}</span>}
                </div>
                <p className="text-xs text-[var(--muted)]">@{c.instagramUsername || "—"}</p>
                <p className="mt-1 line-clamp-1 text-sm">{c.lastMessagePreview}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <span className="badge">Score {c.lead?.score ?? 0}</span>
                  <span className="badge">{c.lead?.stage || "New"}</span>
                  <span className={c.aiPaused ? "badge badge-warn" : "badge"}>{c.handlingMode}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="surface flex flex-col overflow-hidden">
          {!detail ? (
            <div className="p-6 text-[var(--muted)]">Select a conversation</div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
                <div>
                  <h2 className="font-semibold">{detail.contact.fullName}</h2>
                  <p className="text-sm text-[var(--muted)]">
                    @{detail.contact.instagramUsername} · {detail.intent || "No intent"} ·{" "}
                    {detail.sentiment || "—"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => patch({ aiPaused: true, handlingMode: "PAUSED" })}
                  >
                    Pause AI
                  </button>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => patch({ aiPaused: false, handlingMode: "AI" })}
                  >
                    Resume AI
                  </button>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => patch({ qualificationStatus: "QUALIFIED" })}
                  >
                    Mark qualified
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => patch({ qualificationStatus: "DISQUALIFIED" })}
                  >
                    Disqualify
                  </button>
                </div>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {detail.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                      m.direction === "OUTBOUND"
                        ? "ml-auto bg-[var(--accent)] text-white"
                        : "bg-[var(--surface-2)]"
                    }`}
                  >
                    <p className="mb-1 text-[10px] uppercase opacity-70">{m.senderType}</p>
                    <p className="whitespace-pre-wrap">{m.body}</p>
                  </div>
                ))}
              </div>

              <form onSubmit={onReply} className="border-t border-[var(--border)] p-4">
                <textarea
                  className="input min-h-24"
                  placeholder="Write a manual reply (pauses AI)"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                />
                <div className="mt-2 flex justify-end">
                  <button className="btn btn-primary" type="submit">
                    Send reply
                  </button>
                </div>
              </form>
            </>
          )}
        </section>

        <section className="surface overflow-y-auto p-4">
          {!detail ? (
            <p className="text-sm text-[var(--muted)]">Contact details appear here.</p>
          ) : (
            <div className="space-y-4 text-sm">
              <div>
                <h3 className="font-semibold">Messaging window</h3>
                {messagingWindow ? (
                  <ul className="mt-2 space-y-1 text-xs">
                    <li>
                      AI reply:{" "}
                      <span className={messagingWindow.automatedReplyAllowed ? "badge badge-success" : "badge badge-danger"}>
                        {messagingWindow.automatedReplyAllowed ? "Allowed" : "Blocked"}
                      </span>
                      {" · "}
                      {formatDurationRemaining(messagingWindow.automatedMsRemaining)} left
                    </li>
                    <li>
                      Manual reply:{" "}
                      <span className={messagingWindow.humanReplyAllowed ? "badge badge-success" : "badge badge-warn"}>
                        {messagingWindow.humanReplyAllowed ? "Allowed" : "Blocked"}
                      </span>
                      {" · "}
                      {formatDurationRemaining(messagingWindow.humanMsRemaining)} left
                    </li>
                    {messagingWindow.automatedBlockedReason && (
                      <li className="text-[var(--danger)]">{messagingWindow.automatedBlockedReason}</li>
                    )}
                    {messagingWindow.humanBlockedReason && (
                      <li className="text-[var(--muted)]">{messagingWindow.humanBlockedReason}</li>
                    )}
                  </ul>
                ) : (
                  <p className="text-[var(--muted)]">No window data</p>
                )}
              </div>
              <div>
                <h3 className="font-semibold">Contact</h3>
                <p>{detail.contact.email || "No email"}</p>
                <p>{detail.contact.phone || "No phone"}</p>
                <p>Source: {detail.contact.leadSource || "—"}</p>
                {detail.contact.optedOut && <span className="badge badge-danger">Opted out</span>}
              </div>
              <div>
                <h3 className="font-semibold">Assignee</h3>
                <select className="input mt-2" value={detail.assignments?.[0]?.user.id || ""} onChange={(e) => patch({ assignUserId: e.target.value || null })}>
                  <option value="">Unassigned</option>
                  {members.map((member) => <option key={member.id} value={member.id}>{member.name || member.email}</option>)}
                </select>
              </div>
              <div>
                <h3 className="font-semibold">Internal note</h3>
                <textarea className="input mt-2 min-h-20" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note" />
                <button className="btn btn-secondary mt-2" type="button" onClick={() => { if (note.trim()) patch({ note }).then(() => setNote("")); }}>Save note</button>
              </div>
              <div>
                <h3 className="font-semibold">Lead summary</h3>
                <p className="text-[var(--muted)]">{detail.summary || "No summary yet"}</p>
                <p className="mt-2">
                  Score: <span className="badge badge-success">{lead?.score ?? 0}</span>
                </p>
                <p className="mt-1 text-xs text-[var(--muted)]">{lead?.scoreExplanation}</p>
                {lead?.scoreEvents && lead.scoreEvents.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
                    {lead.scoreEvents.slice(0, 5).map((ev) => (
                      <li key={ev.id}>
                        {ev.previousScore} → {ev.newScore} ({ev.delta >= 0 ? "+" : ""}
                        {ev.delta}): {ev.reason}
                      </li>
                    ))}
                  </ul>
                )}
                {lead?.bookings && lead.bookings.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs">
                    {lead.bookings.map((b) => (
                      <li key={b.id}>
                        Booking <span className="badge">{b.status}</span>
                        {b.bookingUrl ? ` · ${b.bookingUrl}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="font-semibold">Pipeline stage</h3>
                <select
                  className="input mt-2"
                  value={lead?.stageId || ""}
                  onChange={(e) => patch({ stageId: e.target.value })}
                >
                  <option value="" disabled>
                    Select stage
                  </option>
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <h3 className="font-semibold">Objections</h3>
                <ul className="mt-1 space-y-1">
                  {detail.objections.length === 0 && <li className="text-[var(--muted)]">None</li>}
                  {detail.objections.map((o) => (
                    <li key={o.id}>
                      <span className="badge">{o.category}</span> {o.text}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="font-semibold">Questions</h3>
                <ul className="mt-1 space-y-1">
                  {detail.questions.length === 0 && <li className="text-[var(--muted)]">None</li>}
                  {detail.questions.map((q) => (
                    <li key={q.id}>{q.text}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="font-semibold">Buying signals</h3>
                <ul className="mt-1 space-y-1">
                  {detail.buyingSignals.length === 0 && <li className="text-[var(--muted)]">None</li>}
                  {detail.buyingSignals.map((b) => (
                    <li key={b.id}>{b.text}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="font-semibold">Follow-ups</h3>
                <ul className="mt-1 space-y-1">
                  {detail.followUps.map((f) => (
                    <li key={f.id}>
                      #{f.attemptNumber} {f.status} · {new Date(f.scheduledFor).toLocaleString()}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
