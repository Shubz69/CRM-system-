"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SlideOver } from "@/components/ui/slide-over";
import { knowledgeFreshness, statusLabel } from "@/lib/customer-labels";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";

type Doc = {
  id: string;
  title: string;
  category: string;
  content: string;
  status: string;
  version: number;
  updatedAt?: string;
  _count: { chunks: number; versions: number };
};

type Recommendation = {
  id: string;
  question: string;
  draftAnswer: string | null;
  reason: string | null;
  status: string;
  createdAt: string;
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "current", label: "Current" },
  { id: "review", label: "Review needed" },
  { id: "outdated", label: "Outdated" },
] as const;

function freshnessBadge(updatedAt?: string) {
  const { label, tone } = knowledgeFreshness(updatedAt);
  const className =
    tone === "success"
      ? "badge badge-success"
      : tone === "warn"
        ? "badge badge-warn"
        : "badge badge-danger";
  return <span className={className}>{label}</span>;
}

export default function KnowledgePage() {
  const workspaceContext = getImmutableWorkspaceContext(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("faq");
  const [content, setContent] = useState("");
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<"write" | "upload">("write");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");

  async function load() {
    const [docsRes, recRes] = await Promise.all([
      fetch("/api/knowledge"),
      fetch("/api/knowledge/recommendations"),
    ]);
    const docsJson = await docsRes.json();
    if (!docsRes.ok) throw new Error(docsJson.error || "Failed");
    setDocs(docsJson.documents);
    if (recRes.ok) {
      const recJson = await recRes.json();
      setRecommendations(recJson.recommendations || []);
    }
  }

  useEffect(() => {
    load().catch((e) => toast.error(e.message));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (replaceId) {
      const res = await workspaceFetch(
        workspaceContext.loadedOrganisationId,
        workspaceContext.workspaceRevision,
        "/api/knowledge",
        {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: replaceId, title, category, content, status: "ACTIVE" }),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Replace failed");
        return;
      }
      toast.success("Document replaced");
      setReplaceId(null);
    } else {
      const res = await workspaceFetch(
        workspaceContext.loadedOrganisationId,
        workspaceContext.workspaceRevision,
        "/api/knowledge",
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, category, content }),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Save failed");
        return;
      }
      toast.success("Knowledge saved");
    }
    setTitle("");
    setContent("");
    setDrawerOpen(false);
    await load();
  }

  const filtered = useMemo(() => {
    return docs.filter((doc) => {
      const { tone } = knowledgeFreshness(doc.updatedAt);
      if (filter === "all") return true;
      if (filter === "current") return tone === "success" && doc.status === "ACTIVE";
      if (filter === "review") return tone === "warn" || doc.status !== "ACTIVE";
      if (filter === "outdated") return tone === "danger";
      return true;
    });
  }, [docs, filter]);

  function openWrite(doc?: Doc) {
    if (doc) {
      setReplaceId(doc.id);
      setTitle(doc.title);
      setCategory(doc.category);
      setContent(doc.content);
    } else {
      setReplaceId(null);
      setTitle("");
      setContent("");
      setCategory("faq");
    }
    setDrawerMode("write");
    setDrawerOpen(true);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        description="Keep business knowledge current so answers stay accurate."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => openWrite()}>
            + Add
          </button>
        }
      />

      <div className="filter-bar">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`badge ${filter === f.id ? "badge-success" : ""}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="section-title">Library</h2>
          {recommendations.length > 0 ? (
            <span className="badge badge-warn">{recommendations.length} gaps</span>
          ) : null}
        </div>

        {docs.length === 0 ? (
          <EmptyState
            title="Teach the AI what your business knows"
            body="Add FAQs, pricing, and tone of voice so replies stay accurate."
            actions={[
              { href: "/ask", label: "Research something first" },
            ]}
          />
        ) : filtered.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No documents in this view.</p>
        ) : (
          <div className="grid gap-2">
            {filtered.map((doc) => (
              <article key={doc.id} className="surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">{doc.title}</h3>
                  <span className="badge">{doc.category}</span>
                  <span className="badge">{statusLabel(doc.status)}</span>
                  {freshnessBadge(doc.updatedAt)}
                </div>
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-[var(--muted)]">
                  {doc.content}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className="btn btn-secondary" type="button" onClick={() => openWrite(doc)}>
                    Replace
                  </button>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={async () => {
                      const res = await workspaceFetch(
                        workspaceContext.loadedOrganisationId,
                        workspaceContext.workspaceRevision,
                        "/api/knowledge",
                        {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          id: doc.id,
                          status: doc.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
                        }),
                        },
                      );
                      if (!res.ok) {
                        toast.error("Update failed");
                        return;
                      }
                      await load();
                    }}
                  >
                    {doc.status === "ACTIVE" ? "Deactivate" : "Activate"}
                  </button>
                  <Link href="/ask" className="btn btn-secondary">
                    Research
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {recommendations.length > 0 ? (
        <section className="space-y-3">
          <h2 className="section-title">Knowledge gaps</h2>
          {recommendations.map((rec) => (
            <article key={rec.id} className="surface-attention p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="badge badge-warn">Needs information</span>
                <p className="font-medium">{rec.question}</p>
              </div>
              {rec.reason && <p className="mt-2 text-xs text-[var(--muted)]">{rec.reason}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={async () => {
                    const res = await workspaceFetch(
                      workspaceContext.loadedOrganisationId,
                      workspaceContext.workspaceRevision,
                      "/api/knowledge/recommendations",
                      {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: rec.id, status: "APPROVED" }),
                      },
                    );
                    if (!res.ok) {
                      toast.error("Update failed");
                      return;
                    }
                    toast.success("Approved");
                    await load();
                  }}
                >
                  Review & approve
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={async () => {
                    const res = await workspaceFetch(
                      workspaceContext.loadedOrganisationId,
                      workspaceContext.workspaceRevision,
                      "/api/knowledge/recommendations",
                      {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: rec.id, status: "DISMISSED" }),
                      },
                    );
                    if (!res.ok) {
                      toast.error("Update failed");
                      return;
                    }
                    toast.success("Dismissed");
                    await load();
                  }}
                >
                  Dismiss
                </button>
              </div>
            </article>
          ))}
        </section>
      ) : null}

      <SlideOver
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setReplaceId(null);
        }}
        title={replaceId ? "Replace document" : "Add knowledge"}
        description="Write information, upload a document, or research via Ask."
        wide
      >
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={`badge ${drawerMode === "write" ? "badge-success" : ""}`}
            onClick={() => setDrawerMode("write")}
          >
            Write information
          </button>
          <button
            type="button"
            className={`badge ${drawerMode === "upload" ? "badge-success" : ""}`}
            onClick={() => setDrawerMode("upload")}
          >
            Upload document
          </button>
          <Link href="/ask" className="badge">
            Import / research
          </Link>
        </div>

        {drawerMode === "write" ? (
          <form onSubmit={onSubmit} className="space-y-3">
            <label className="block text-sm font-medium">
              Title
              <input
                className="input mt-1 w-full"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </label>
            <label className="block text-sm font-medium">
              Category
              <select
                className="input mt-1 w-full"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="business">Business</option>
                <option value="pricing">Pricing</option>
                <option value="sop">SOP / policies</option>
                <option value="faq">FAQ</option>
                <option value="tone">Brand / tone</option>
                <option value="scripts">Sales scripts</option>
              </select>
            </label>
            <label className="block text-sm font-medium">
              Content
              <textarea
                className="input mt-1 min-h-40 w-full"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                required
              />
            </label>
            <button className="btn btn-primary" type="submit">
              {replaceId ? "Replace document" : "Save document"}
            </button>
          </form>
        ) : (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const data = new FormData(form);
              const res = await workspaceFetch(
                workspaceContext.loadedOrganisationId,
                workspaceContext.workspaceRevision,
                "/api/knowledge",
                { method: "POST", body: data },
              );
              const json = await res.json();
              if (!res.ok) {
                toast.error(json.error || "Upload failed");
                return;
              }
              toast.success(`Uploaded (${json.extractedChars ?? 0} characters extracted)`);
              form.reset();
              setDrawerOpen(false);
              await load();
            }}
          >
            <label className="block text-sm font-medium">
              Title
              <input className="input mt-1 w-full" name="title" required />
            </label>
            <label className="block text-sm font-medium">
              Category
              <input className="input mt-1 w-full" name="category" defaultValue="upload" />
            </label>
            <label className="block text-sm font-medium">
              File
              <input
                className="input mt-1 w-full"
                name="file"
                type="file"
                accept=".pdf,.txt,.md,text/plain,application/pdf"
                required
              />
            </label>
            <button className="btn btn-primary" type="submit">
              Upload & extract
            </button>
          </form>
        )}
      </SlideOver>
    </div>
  );
}
