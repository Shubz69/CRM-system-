"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { toast } from "sonner";

type SocialIdentity = {
  network: string;
  canonicalProfileUrl: string;
  handle?: string;
  verificationState: "VERIFIED" | "LIKELY" | "UNVERIFIED" | "CONFLICTED";
  confidence?: number;
};

type Prospect = {
  id: string;
  personName?: string | null;
  companyName?: string | null;
  role?: string | null;
  location?: string | null;
  fitScore?: number | null;
  confidence?: number | null;
  reasonSelected?: string | null;
  linkedinUrl?: string | null;
  instagramUrl?: string | null;
  otherSocialUrls?: string[] | null;
  socialIdentities?: SocialIdentity[] | null;
  uncertaintyFlags?: string[] | null;
  sourceEvidence?: unknown;
  status?: string;
};

type LinkedInSurface = {
  sendConnection: boolean;
  actions: string[];
  note?: string;
};

type DiscoveryProgress = {
  liveResearch?: boolean;
  tiersTried?: string[];
  externalCalls?: number;
  billableCents?: number;
  sourcesConfigured?: string[];
  degraded?: boolean;
  degradationNotes?: string[];
  computeMode?: string;
};

type OutreachDrafts = {
  connectionNote?: string;
  followUpOne?: string;
  followUpTwo?: string;
  instagramMessage?: string;
  instagramFollowUp?: string;
  genericSocialOutreach?: string;
};

function showableIdentities(p: Prospect): SocialIdentity[] {
  const list = Array.isArray(p.socialIdentities) ? p.socialIdentities : [];
  return list.filter((i) => i.verificationState === "VERIFIED" || i.verificationState === "LIKELY");
}

export default function SocialProspectingPage() {
  const [query, setQuery] = useState("");
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [linkedIn, setLinkedIn] = useState<LinkedInSurface | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<DiscoveryProgress | null>(null);
  const [draftsByProspect, setDraftsByProspect] = useState<Record<string, OutreachDrafts>>({});
  const [entity, setEntity] = useState<"People" | "Companies">("People");
  const [network, setNetwork] = useState<"Any" | "LinkedIn" | "Instagram" | "X" | "TikTok">("Any");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [previousRuns, setPreviousRuns] = useState<
    Array<{ searchRunId: string; retrievedAt: string; query?: string }>
  >([]);
  const [qualityNote, setQualityNote] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (runId?: string | null) => {
    setLoadError(null);
    const qs = new URLSearchParams();
    if (runId) qs.set("runId", runId);
    qs.set("includeRuns", "1");
    const res = await fetch(`/api/social-prospecting?${qs.toString()}`);
    if (!res.ok) {
      setLoadError("Could not load prospects");
      return;
    }
    const json = await res.json();
    setProspects(json.prospects || []);
    setLinkedIn(json.linkedIn || null);
    if (json.previousRuns) setPreviousRuns(json.previousRuns);
    if (runId) setActiveRunId(runId);
  }, []);

  useEffect(() => {
    void (async () => {
      // Load latest active run only — never flatten all historical prospects on mount.
      const res = await fetch("/api/social-prospecting?includeRuns=1");
      if (!res.ok) {
        setLoadError("Could not load prospects");
        return;
      }
      const json = await res.json();
      setProspects(json.prospects || []);
      setLinkedIn(json.linkedIn || null);
      if (json.previousRuns) setPreviousRuns(json.previousRuns);
      if (json.activeRunId) setActiveRunId(json.activeRunId);
    })();
  }, []);

  async function discover() {
    if (!query.trim()) {
      toast.error("Tell Agent Desk who to find");
      return;
    }
    setBusy(true);
    setProgress({ liveResearch: true, tiersTried: ["starting"] });
    setQualityNote(null);
    setProspects([]);
    try {
      const composed = [
        query.trim(),
        entity === "Companies" ? "companies" : "people",
        network !== "Any" ? network : "",
      ]
        .filter(Boolean)
        .join(" ");
      const res = await fetch("/api/social-prospecting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "discover",
          query: composed,
          costLimits: {
            maxCandidates: 10,
            maxExternalCalls: 6,
            maxEstimatedCostCents: 50,
            maxResearchDepth: "STANDARD",
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Discovery failed");
      setProgress(json.progress || {
        liveResearch: json.liveResearch,
        tiersTried: json.tiersTried,
        externalCalls: json.externalCalls,
        billableCents: json.billableCents,
        sourcesConfigured: json.sourcesConfigured,
        degraded: json.degraded,
        degradationNotes: json.degradationNotes,
        computeMode: json.computeMode,
      });
      const runId = json.searchRunId as string | undefined;
      setActiveRunId(runId || null);
      setProspects(json.candidates || []);
      setQualityNote(json.qualityNote || null);
      const n = json.candidates?.length ?? 0;
      const requested = json.requestedCount ?? n;
      if (json.qualityNote) {
        toast.message(json.qualityNote);
      } else if (json.degraded) {
        toast.message(`Found ${n} prospects (degraded — check source config)`);
      } else {
        toast.success(`Found ${n} of ${requested} requested`);
      }
      if (runId) await load(runId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Discovery failed");
      setLoadError(error instanceof Error ? error.message : "Discovery failed");
    } finally {
      setBusy(false);
    }
  }

  async function ingest(id: string) {
    const res = await fetch("/api/social-prospecting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "ingest", prospectId: id }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Could not add to CRM");
      return;
    }
    toast.success("Added to CRM · Opportunity created");
    await load(activeRunId);
  }

  async function prepareOutreach(id: string) {
    const res = await fetch("/api/social-prospecting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "prepare_outreach", prospectId: id }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Could not prepare outreach");
      return;
    }
    setDraftsByProspect((prev) => ({ ...prev, [id]: json.drafts || {} }));
    toast.success("Outreach drafts ready — use Open + Copy");
  }

  function copyText(label: string, text?: string | null) {
    if (!text) {
      toast.error(`No ${label} available`);
      return;
    }
    void navigator.clipboard.writeText(text).then(() => toast.success(`${label} copied`));
  }

  function profileVerified(p: Prospect): boolean {
    return showableIdentities(p).length > 0 || Boolean(p.linkedinUrl || p.instagramUrl);
  }

  return (
    <PageShell>
      <PageHeader description="Find people and companies through live research — then outreach with Open/Copy across networks." />

      <div className="surface max-w-3xl p-5">
        <p className="font-[family-name:var(--font-fraunces)] text-2xl tracking-tight">
          Who would you like Agent Desk to find?
        </p>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Agent Desk interprets your ICP, runs progressive research (web / approved sources / CRM),
          resolves social identities only when evidence supports them, then prepares outreach. LinkedIn
          is never used as a people-search database.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {(["People", "Companies"] as const).map((chip) => (
            <button
              key={chip}
              type="button"
              className={`btn ${entity === chip ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setEntity(chip)}
            >
              {chip}
            </button>
          ))}
          {(["Any", "LinkedIn", "Instagram", "X", "TikTok"] as const).map((chip) => (
            <button
              key={chip}
              type="button"
              className={`btn ${network === chip ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setNetwork(chip)}
            >
              {chip}
            </button>
          ))}
        </div>
        <textarea
          className="input mt-4 min-h-[96px] w-full"
          placeholder='e.g. "Find 5 UK recruitment company founders"'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn btn-primary mt-3" type="button" disabled={busy} onClick={() => void discover()}>
          {busy ? "Researching…" : "Find prospects"}
        </button>
        {busy || progress ? (
          <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm">
            <p className="font-medium">{busy ? "Progress" : "Last run"}</p>
            <p className="meta mt-1">
              {progress?.liveResearch === false
                ? "Fixture / seed mode"
                : `Live research · mode ${progress?.computeMode || "—"}`}
            </p>
            {progress?.tiersTried?.length ? (
              <p className="meta mt-1">Tiers: {progress.tiersTried.join(" → ")}</p>
            ) : null}
            <p className="meta mt-1">
              External calls: {progress?.externalCalls ?? "—"} · Est. cost:{" "}
              {progress?.billableCents != null ? `${progress.billableCents}¢` : "—"}
            </p>
            {progress?.degraded ? (
              <p className="mt-2 text-amber-700 dark:text-amber-400">
                Degraded: {(progress.degradationNotes || []).join("; ") || "some sources unavailable"}
              </p>
            ) : null}
          </div>
        ) : null}
        {linkedIn && (
          <p className="meta mt-3">
            LinkedIn actions: {linkedIn.actions.join(" · ")}
            {linkedIn.sendConnection ? "" : " — Send LinkedIn disabled until provider approval"}
          </p>
        )}
      </div>

      <div className="mt-6 grid gap-3">
        {qualityNote ? (
          <p className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm">
            {qualityNote}
          </p>
        ) : null}
        {loadError ? (
          <p className="text-sm text-[var(--danger)]">{loadError}</p>
        ) : null}
        {busy ? (
          <p className="text-sm text-[var(--muted)]">Researching this search run…</p>
        ) : null}
        {!busy && prospects.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            {activeRunId
              ? "No sufficiently verified matches for this search."
              : "No prospects yet. Run a search to get started."}
          </p>
        ) : (
          prospects.map((p) => {
            const ids = showableIdentities(p);
            const drafts = draftsByProspect[p.id];
            const verified = profileVerified(p);
            return (
              <article key={p.id} className="surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="card-title">
                      {p.personName || p.companyName || "Prospect"}
                      {p.companyName && p.personName ? ` · ${p.companyName}` : ""}
                    </h2>
                    <p className="meta mt-1">
                      {[p.role, p.location].filter(Boolean).join(" · ") || "Details from research"}
                    </p>
                    <p className="mt-2 text-sm">
                      Fit {p.fitScore != null ? Math.round(p.fitScore * 100) : "—"}%
                      {p.confidence != null ? ` · Confidence ${Math.round(p.confidence * 100)}%` : ""}
                    </p>
                    <p className="mt-2 text-sm text-[var(--muted)]">
                      Why selected: {p.reasonSelected || "Evidence-backed match"}
                    </p>
                    <div className="mt-3 space-y-1 text-sm">
                      {verified ? (
                        ids.map((id) => (
                          <p key={`${id.network}-${id.canonicalProfileUrl}`}>
                            <span className="meta">{id.network}</span>{" "}
                            <a href={id.canonicalProfileUrl} target="_blank" rel="noreferrer" className="underline">
                              {id.canonicalProfileUrl}
                            </a>{" "}
                            <span className="meta">({id.verificationState.toLowerCase()})</span>
                          </p>
                        ))
                      ) : (
                        <p className="text-[var(--muted)]">Profile not verified</p>
                      )}
                      {!ids.length && p.linkedinUrl ? (
                        <p>
                          <span className="meta">LINKEDIN</span>{" "}
                          <a href={p.linkedinUrl} target="_blank" rel="noreferrer" className="underline">
                            {p.linkedinUrl}
                          </a>
                        </p>
                      ) : null}
                      {!ids.length && p.instagramUrl ? (
                        <p>
                          <span className="meta">INSTAGRAM</span>{" "}
                          <a href={p.instagramUrl} target="_blank" rel="noreferrer" className="underline">
                            {p.instagramUrl}
                          </a>
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn btn-secondary" onClick={() => void ingest(p.id)}>
                      Add to CRM
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={() => void prepareOutreach(p.id)}>
                      Prepare outreach
                    </button>
                    {p.linkedinUrl ? (
                      <>
                        <a className="btn btn-secondary" href={p.linkedinUrl} target="_blank" rel="noreferrer">
                          Open LinkedIn
                        </a>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => copyText("Connection note", drafts?.connectionNote)}
                        >
                          Copy Connection Note
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => copyText("Follow-up DM", drafts?.followUpOne)}
                        >
                          Copy Follow-up DM
                        </button>
                      </>
                    ) : null}
                    {p.instagramUrl ? (
                      <>
                        <a className="btn btn-secondary" href={p.instagramUrl} target="_blank" rel="noreferrer">
                          Open Instagram
                        </a>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => copyText("DM", drafts?.instagramMessage || drafts?.connectionNote)}
                        >
                          Copy DM
                        </button>
                      </>
                    ) : null}
                    {ids
                      .filter((i) => i.network !== "LINKEDIN" && i.network !== "INSTAGRAM")
                      .map((id) => (
                        <span key={id.canonicalProfileUrl} className="inline-flex flex-wrap gap-2">
                          <a className="btn btn-secondary" href={id.canonicalProfileUrl} target="_blank" rel="noreferrer">
                            Open Profile
                          </a>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() =>
                              copyText("Outreach", drafts?.genericSocialOutreach || drafts?.connectionNote)
                            }
                          >
                            Copy Outreach
                          </button>
                        </span>
                      ))}
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>

      {previousRuns.length > 0 ? (
        <div className="mt-8 surface p-4">
          <p className="text-sm font-medium">Previous searches</p>
          <ul className="mt-2 space-y-1 text-sm text-[var(--muted)]">
            {previousRuns.map((r) => (
              <li key={r.searchRunId}>
                <button
                  type="button"
                  className="text-left underline-offset-2 hover:underline"
                  onClick={() => void load(r.searchRunId)}
                >
                  {r.query || r.searchRunId} · {new Date(r.retrievedAt).toLocaleString()}
                  {activeRunId === r.searchRunId ? " (active)" : ""}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </PageShell>
  );
}
