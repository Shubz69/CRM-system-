"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { evaluateMessagingWindow, formatDurationRemaining } from "@/lib/messaging-window";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-state";
import { statusLabel } from "@/lib/customer-labels";
import { useSession } from "next-auth/react";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";

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
  const { data: session } = useSession();
  const workspaceContext = useMemo(
    () => getImmutableWorkspaceContext(session?.user?.organisationId ?? null),
    [session?.user?.organisationId],
  );
  const [items, setItems] = useState<ConversationListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    searchParams.get("c") || searchParams.get("conversationId"),
  );
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [reply, setReply] = useState("");
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<Member[]>([]);
  const [note, setNote] = useState("");
  const [queue, setQueue] = useState<"all" | "needs_reply" | "hot" | "human" | "waiting">("all");
  const [mobilePanel, setMobilePanel] = useState<"list" | "thread">("list");
  const [showCustomerSheet, setShowCustomerSheet] = useState(false);
  const detailSeq = useRef(0);
  const detailAbort = useRef<AbortController | null>(null);
  const selectedIdRef = useRef<string | null>(selectedId);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const loadList = useCallback(async () => {
    const res = await fetch("/api/conversations");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load inbox");
    setItems(json.conversations);
    setSelectedId((current) => current ?? json.conversations[0]?.id ?? null);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    detailAbort.current?.abort();
    const ac = new AbortController();
    detailAbort.current = ac;
    const seq = ++detailSeq.current;
    try {
      const res = await fetch(`/api/conversations/${id}`, { signal: ac.signal });
      if (seq !== detailSeq.current || selectedIdRef.current !== id) return;
      const json = await res.json();
      if (seq !== detailSeq.current || selectedIdRef.current !== id) return;
      if (!res.ok) throw new Error(json.error || "Failed to load conversation");
      if (json.conversation?.id !== id) return;
      if (selectedIdRef.current !== id) return;
      setDetail(json.conversation);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (seq !== detailSeq.current || selectedIdRef.current !== id) return;
      throw e;
    }
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
    const fromQuery = searchParams.get("c") || searchParams.get("conversationId");
    if (fromQuery) {
      setSelectedId(fromQuery);
      setMobilePanel("thread");
    }
  }, [searchParams]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    // Clear stale thread immediately so we never show A while B is selected.
    setDetail((prev) => (prev && prev.id === selectedId ? prev : null));
    loadDetail(selectedId).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
      toast.error(e.message);
    });
    return () => {
      detailAbort.current?.abort();
    };
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (!showCustomerSheet) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShowCustomerSheet(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showCustomerSheet]);

  const lead = detail?.leads?.[0];
  const sendTargetMatches =
    Boolean(selectedId) && Boolean(detail) && detail?.id === selectedId;
  const optedOut = Boolean(detail?.contact.optedOut);

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
    if (!sendTargetMatches) {
      toast.error("Conversation view is still loading — wait before sending.");
      return;
    }
    if (body.reply && optedOut) {
      toast.error("Do not contact — customer opted out.");
      return;
    }
    const res = await workspaceFetch(
      workspaceContext.loadedOrganisationId,
      workspaceContext.workspaceRevision,
      `/api/conversations/${selectedId}`,
      {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      },
    );
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
    if (!sendTargetMatches) {
      toast.error("Selected conversation does not match the open thread — send blocked.");
      return;
    }
    if (optedOut) {
      toast.error("Do not contact — customer opted out.");
      return;
    }
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

  const filtered = useMemo(() => {
    return sorted.filter((c) => {
      if (queue === "all") return true;
      if (queue === "human") return c.needsHumanReview || c.aiPaused;
      if (queue === "hot") return (c.lead?.score ?? 0) >= 70;
      if (queue === "needs_reply") {
        if (c.unreadCount > 0) return true;
        if (!c.lastMessageAt) return false;
        return c.unreadCount > 0 || Boolean(c.lastMessagePreview);
      }
      if (queue === "waiting") {
        return !c.needsHumanReview && !c.aiPaused && c.unreadCount === 0;
      }
      return true;
    });
  }, [queue, sorted]);

  if (loading) return <PageLoading label="Loading inbox" />;

  const customerPanel = detail ? (
    <div className="space-y-4 text-sm">
      <div>
        <h3 className="caption">Customer</h3>
        <p className="card-title mt-1">{detail.contact.fullName}</p>
        <p className="meta">{detail.contact.email || "No email"}</p>
        <p className="meta">{detail.contact.phone || "No phone"}</p>
        <p className="meta">
          Source:{" "}
          {detail.contact.leadSource === "simulator"
            ? "Test conversation"
            : detail.contact.leadSource || "Unknown"}
        </p>
        {detail.contact.optedOut && <span className="badge badge-danger mt-1">Opted out</span>}
      </div>
      <div>
        <h3 className="caption">Messaging window</h3>
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
          </ul>
        ) : (
          <p className="meta">No window data</p>
        )}
      </div>
      <div>
        <h3 className="caption">Qualification</h3>
        <p className="mt-1">
          Score <span className="badge badge-success">{lead?.score ?? 0}</span>
          {" · "}
          <span className="badge">{statusLabel(lead?.qualificationStatus || "UNQUALIFIED")}</span>
        </p>
        <p className="meta mt-1">{lead?.stage?.name || detail.intent || "No stage yet"}</p>
      </div>
      <div>
        <h3 className="caption">Owner</h3>
        <select
          className="input mt-2"
          value={detail.assignments?.[0]?.user.id || ""}
          onChange={(e) => patch({ assignUserId: e.target.value || null })}
        >
          <option value="">Unassigned</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name || member.email}
            </option>
          ))}
        </select>
      </div>
      <details>
        <summary className="caption cursor-pointer">Signals & follow-ups</summary>
        <div className="mt-2 space-y-3">
          <div>
            <p className="card-title">Objections</p>
            <ul className="mt-1 space-y-1">
              {detail.objections.length === 0 && <li className="meta">None recorded</li>}
              {detail.objections.map((o) => (
                <li key={o.id}>
                  <span className="badge">{o.category}</span> {o.text}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="card-title">Buying signals</p>
            <ul className="mt-1 space-y-1">
              {detail.buyingSignals.length === 0 && <li className="meta">None recorded</li>}
              {detail.buyingSignals.map((b) => (
                <li key={b.id}>{b.text}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="card-title">Follow-ups</p>
            <ul className="mt-1 space-y-1">
              {detail.followUps.length === 0 && <li className="meta">None scheduled</li>}
              {detail.followUps.map((f) => (
                <li key={f.id}>
                  #{f.attemptNumber} {statusLabel(f.status)} · {new Date(f.scheduledFor).toLocaleString()}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>
      <div>
        <h3 className="caption">Internal note</h3>
        <textarea className="input mt-2 min-h-20" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note" />
        <button
          className="btn btn-secondary mt-2"
          type="button"
          onClick={() => {
            if (note.trim()) patch({ note }).then(() => setNote(""));
          }}
        >
          Save note
        </button>
      </div>
      <div>
        <h3 className="caption">Pipeline stage</h3>
        <select className="input mt-2" value={lead?.stageId || ""} onChange={(e) => patch({ stageId: e.target.value })}>
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
    </div>
  ) : (
    <p className="text-sm text-[var(--muted)]">Customer intelligence appears when you select a conversation.</p>
  );

  return (
    <div className="space-y-4" data-inbox-ready="true" data-selected-conversation-id={selectedId || ""}>
      <PageHeader description="Reply, qualify, and hand off — Agent Desk keeps safety rules on every send." />

      {!loading && items.length === 0 ? (
        <div className="mx-auto flex min-h-[58vh] max-w-xl flex-col items-center justify-center px-4 text-center">
          <p className="font-[family-name:var(--font-fraunces)] text-3xl tracking-tight text-[var(--foreground)]">
            Connect messaging to open your inbox
          </p>
          <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
            Once Instagram (or another channel) is connected, Agent Desk can capture conversations,
            qualify leads, spot objections, recommend replies, schedule follow-ups, and hand off to a
            human when needed.
          </p>
          <ul className="mt-6 w-full space-y-2 text-left text-sm text-[var(--muted)]">
            {[
              "Conversation capture",
              "Qualification & scoring",
              "Objection detection",
              "Recommended replies",
              "Follow-ups & human handoff",
            ].map((line) => (
              <li
                key={line}
                className="flex items-center gap-2 rounded-lg border border-[var(--border)]/80 bg-[var(--surface)] px-3 py-2"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" aria-hidden />
                {line}
              </li>
            ))}
          </ul>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <a href="/integrations" className="btn btn-primary">
              Connect Instagram
            </a>
            <a href="/simulator" className="btn btn-secondary">
              Try a test conversation
            </a>
            <a href="/settings/go-live" className="btn btn-secondary">
              View setup progress
            </a>
          </div>
        </div>
      ) : (
      <div className="grid gap-4 md:grid-cols-[280px_1fr] xl:grid-cols-[320px_1fr_300px]" style={{ minHeight: "70vh" }}>
        <section className={`surface overflow-hidden ${mobilePanel === "thread" ? "hidden md:block" : "block"}`}>
          <div className="border-b border-[var(--border)] px-4 py-3">
            <p className="font-medium">Conversations</p>
            <div className="filter-bar mt-2">
              {(
                [
                  ["all", "All"],
                  ["needs_reply", "Needs reply"],
                  ["hot", "Hot leads"],
                  ["human", "Human required"],
                  ["waiting", "Waiting"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`badge ${queue === id ? "badge-success" : ""}`}
                  onClick={() => setQueue(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {filtered.length === 0 && sorted.length === 0 && (
              <div className="p-4">
                <EmptyState
                  title="Your inbox is ready"
                  body="Connect Instagram through ManyChat, or send a test DM to see how Agent Desk qualifies a real conversation."
                  actions={[
                    { href: "/integrations", label: "Connect Instagram", primary: true },
                    { href: "/simulator", label: "Simulate a test DM" },
                    { href: "/settings/go-live", label: "Setup progress" },
                  ]}
                />
              </div>
            )}
            {filtered.length === 0 && sorted.length > 0 && (
              <p className="p-4 text-sm text-[var(--muted)]">No conversations in this queue.</p>
            )}
            {filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                data-testid={`inbox-row-${c.id}`}
                data-conversation-id={c.id}
                onClick={() => {
                  setSelectedId(c.id);
                  setMobilePanel("thread");
                  setShowCustomerSheet(false);
                }}
                className={`block w-full border-b border-[var(--border)] px-4 py-3 text-left hover:bg-[var(--surface-2)] ${
                  selectedId === c.id ? "bg-[var(--accent-soft)]" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{c.contactName || "Unknown"}</span>
                  {c.unreadCount > 0 && <span className="badge badge-success">{c.unreadCount}</span>}
                </div>
                <p className="text-xs text-[var(--muted)]">@{c.instagramUsername || "—"}</p>
                <p className="mt-1 line-clamp-1 text-sm">{c.lastMessagePreview}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <span className="badge">Score {c.lead?.score ?? 0}</span>
                  <span className="badge">{c.lead?.stage || "New"}</span>
                  {c.lead?.qualificationStatus ? (
                    <span className="badge">{statusLabel(c.lead.qualificationStatus)}</span>
                  ) : null}
                  <span className={c.aiPaused ? "badge badge-warn" : "badge"}>
                    {c.aiPaused ? "Human" : c.handlingMode === "AI" ? "AI" : c.handlingMode}
                  </span>
                  {c.needsHumanReview ? <span className="badge badge-warn">Handoff</span> : null}
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className={`surface flex flex-col overflow-hidden ${mobilePanel === "list" ? "hidden md:flex" : "flex"}`}>
          {!selectedId ? (
            <div className="p-6 text-[var(--muted)]" data-inbox-empty="true">
              Select a conversation
            </div>
          ) : !detail || detail.id !== selectedId ? (
            <div className="p-6 text-[var(--muted)]" data-inbox-loading={selectedId}>
              Loading conversation…
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
                <div className="min-w-0">
                  <div className="mb-2 flex items-center gap-2 md:hidden">
                    <button type="button" className="btn btn-secondary text-xs" onClick={() => setMobilePanel("list")}>
                      Back
                    </button>
                    <button type="button" className="btn btn-secondary text-xs" onClick={() => setShowCustomerSheet(true)}>
                      Customer
                    </button>
                  </div>
                  <h2
                    className="truncate font-semibold"
                    data-testid="inbox-detail-header"
                    data-conversation-id={detail.id}
                  >
                    {detail.contact.fullName}
                  </h2>
                  <p
                    className="text-sm text-[var(--muted)]"
                    data-testid="inbox-thread"
                    data-conversation-id={detail.id}
                    data-qualification-id={lead?.id || ""}
                    data-qualification-status={lead?.qualificationStatus || ""}
                  >
                    @{detail.contact.instagramUsername} · {detail.intent || "No intent"} · {detail.sentiment || "—"}
                  </p>
                </div>
                <div className="hidden flex-wrap gap-2 sm:flex">
                  <button className="btn btn-secondary" type="button" onClick={() => patch({ aiPaused: true, handlingMode: "PAUSED" })}>
                    Pause AI
                  </button>
                  <button className="btn btn-secondary" type="button" onClick={() => patch({ aiPaused: false, handlingMode: "AI" })}>
                    Resume AI
                  </button>
                  <button className="btn btn-secondary" type="button" onClick={() => patch({ qualificationStatus: "QUALIFIED" })}>
                    Mark qualified
                  </button>
                  <button className="btn btn-danger" type="button" onClick={() => patch({ qualificationStatus: "DISQUALIFIED" })}>
                    Disqualify
                  </button>
                  <button type="button" className="btn btn-secondary xl:hidden" onClick={() => setShowCustomerSheet(true)}>
                    Customer intel
                  </button>
                </div>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {optedOut ? (
                  <div className="rounded-xl border border-[color-mix(in_oklab,var(--danger)_35%,var(--border))] bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] p-3">
                    <p className="caption">Do not contact</p>
                    <p className="card-title mt-1">Do not contact — customer opted out.</p>
                    <p className="meta mt-1">
                      Why: Opt-out is recorded on this contact. No qualification, booking, or outreach
                      drafts should be sent.
                    </p>
                  </div>
                ) : detail.needsHumanReview || detail.objections.length > 0 || (lead && lead.qualificationStatus !== "QUALIFIED") ? (
                  <div className="rounded-xl border border-[color-mix(in_oklab,var(--accent)_30%,var(--border))] bg-[var(--accent-soft)]/40 p-3">
                    <p className="caption">Agent Desk suggests</p>
                    <p className="card-title mt-1">
                      {detail.needsHumanReview
                        ? "Hand this conversation to a human — review is required."
                        : detail.objections.length > 0
                          ? "Address the latest objection before pushing for a meeting."
                          : "Ask one more qualification question before offering a booking."}
                    </p>
                    {detail.objections[0] ? (
                      <p className="meta mt-1">
                        Why:{" "}
                        {/price|cost|budget|expensive/i.test(detail.objections[0].category) ||
                        /price|cost|budget|expensive/i.test(detail.objections[0].text)
                          ? "Customer raised a pricing concern — clarify value before advancing."
                          : `Objection category ${detail.objections[0].category} needs a clear answer before advancing.`}
                      </p>
                    ) : lead?.scoreExplanation ? (
                      <p className="meta mt-1">
                        Why:{" "}
                        {lead.scoreExplanation.trim() ===
                        (detail.messages[detail.messages.length - 1]?.body || "").trim()
                          ? "Lead score needs human review — the latest message alone is not a complete explanation."
                          : lead.scoreExplanation}
                      </p>
                    ) : (
                      <p className="meta mt-1">
                        Why: This thread is flagged for review based on qualification status, not a
                        full draft reply.
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn btn-secondary text-xs"
                        onClick={() =>
                          patch({
                            aiPaused: true,
                            handlingMode: "PAUSED",
                            needsHumanReview: true,
                          })
                        }
                      >
                        Hand to human
                      </button>
                    </div>
                  </div>
                ) : null}
                {detail.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                      m.direction === "OUTBOUND" ? "ml-auto bg-[var(--accent)] text-white" : "bg-[var(--surface-2)]"
                    }`}
                  >
                    <p className="mb-1 text-[10px] uppercase opacity-70">
                      {m.senderType === "AI" ? "AI" : m.senderType === "CONTACT" ? "Customer" : "Team"}
                    </p>
                    <p className="whitespace-pre-wrap">{m.body}</p>
                  </div>
                ))}
              </div>

              <form
                onSubmit={onReply}
                className="border-t border-[var(--border)] p-4"
                data-testid="inbox-compose"
                data-conversation-id={detail.id}
                data-action-target={selectedId || ""}
              >
                {!sendTargetMatches ? (
                  <p className="mb-2 text-xs text-[var(--muted)]">
                    Loading the selected conversation — send is blocked until the thread matches.
                  </p>
                ) : null}
                {optedOut ? (
                  <p className="mb-2 text-xs text-[var(--danger)]">
                    Do not contact — customer opted out. Manual and AI replies are blocked.
                  </p>
                ) : null}
                <textarea
                  className="input min-h-24"
                  placeholder={
                    optedOut
                      ? "Contact opted out — replies disabled"
                      : "Write a manual reply (pauses AI)"
                  }
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  disabled={optedOut || !sendTargetMatches}
                />
                <div className="mt-2 flex justify-end">
                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={optedOut || !sendTargetMatches || !reply.trim()}
                  >
                    Send reply
                  </button>
                </div>
              </form>
            </>
          )}
        </section>

        <section className="surface hidden overflow-y-auto p-4 xl:block">{customerPanel}</section>
      </div>
      )}

      {showCustomerSheet && (
        <div
          className="fixed inset-0 z-40 flex justify-end bg-black/40 xl:hidden"
          role="presentation"
          onClick={() => setShowCustomerSheet(false)}
        >
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Customer intelligence"
            className="surface h-full w-full max-w-md overflow-y-auto p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 className="font-semibold">Customer intelligence</h2>
              <button type="button" className="btn btn-secondary" onClick={() => setShowCustomerSheet(false)}>
                Close
              </button>
            </div>
            {customerPanel}
          </aside>
        </div>
      )}
    </div>
  );
}
