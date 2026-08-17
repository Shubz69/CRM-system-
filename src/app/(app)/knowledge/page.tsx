"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/ui/page-header";

type Doc = {
  id: string;
  title: string;
  category: string;
  content: string;
  status: string;
  version: number;
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

export default function KnowledgePage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("faq");
  const [content, setContent] = useState("");

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
    const res = await fetch("/api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, category, content }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Save failed");
      return;
    }
    toast.success("Knowledge saved");
    setTitle("");
    setContent("");
    await load();
  }

  return (
    <div className="space-y-6">
      <PageHeader description="Only relevant chunks are retrieved for the AI. Do not invent prices outside these docs." />

      <form onSubmit={onSubmit} className="surface grid gap-3 p-5 md:grid-cols-2">
        <label className="text-sm font-medium">
          Title
          <input className="input mt-2" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label className="text-sm font-medium">
          Category
          <select className="input mt-2" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="business">Business</option>
            <option value="pricing">Pricing</option>
            <option value="sop">SOP</option>
            <option value="faq">FAQ</option>
            <option value="tone">Tone</option>
            <option value="scripts">Scripts</option>
          </select>
        </label>
        <label className="text-sm font-medium md:col-span-2">
          Content (markdown/text)
          <textarea
            className="input mt-2 min-h-40"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            required
          />
        </label>
        <button className="btn btn-primary md:col-span-2" type="submit">
          Save document
        </button>
      </form>

      <form
        className="surface grid gap-3 p-5 md:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          const res = await fetch("/api/knowledge", { method: "POST", body: data });
          const json = await res.json();
          if (!res.ok) {
            toast.error(json.error || "Upload failed");
            return;
          }
          toast.success(`Uploaded (${json.extractedChars ?? 0} chars extracted)`);
          form.reset();
          await load();
        }}
      >
        <h2 className="h-display text-2xl md:col-span-2">Upload PDF or text file</h2>
        <label className="text-sm font-medium">
          Title
          <input className="input mt-2" name="title" required />
        </label>
        <label className="text-sm font-medium">
          Category
          <input className="input mt-2" name="category" defaultValue="upload" />
        </label>
        <label className="text-sm font-medium md:col-span-2">
          File
          <input className="input mt-2" name="file" type="file" accept=".pdf,.txt,.md,text/plain,application/pdf" required />
        </label>
        <button className="btn btn-secondary md:col-span-2" type="submit">
          Upload & extract
        </button>
      </form>

      <section className="space-y-3">
        <h2 className="h-display text-2xl">Knowledge gaps</h2>
        <p className="text-sm text-[var(--muted)]">
          Recommendations require approval before becoming knowledge. The AI does not auto-publish.
        </p>
        {recommendations.length === 0 && (
          <div className="surface p-4 text-sm text-[var(--muted)]">No open knowledge gaps.</div>
        )}
        {recommendations.map((rec) => (
          <article key={rec.id} className="surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge">{rec.status}</span>
              <p className="font-medium">{rec.question}</p>
            </div>
            {rec.reason && <p className="mt-2 text-xs text-[var(--muted)]">{rec.reason}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {(["APPROVED", "DISMISSED", "REVIEWED"] as const).map((status) => (
                <button
                  key={status}
                  type="button"
                  className="btn btn-secondary"
                  onClick={async () => {
                    const res = await fetch("/api/knowledge/recommendations", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: rec.id, status }),
                    });
                    if (!res.ok) {
                      toast.error("Update failed");
                      return;
                    }
                    toast.success(`Marked ${status.toLowerCase()}`);
                    await load();
                  }}
                >
                  {status.charAt(0) + status.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </article>
        ))}
      </section>

      <div className="grid gap-3">
        {docs.length === 0 && (
          <EmptyState
            title="Teach the AI what your business knows"
            body="Add FAQs, pricing, and tone of voice so replies stay accurate. Or research a topic on Home and save the brief here as a draft."
            actionHref="/ask"
            actionLabel="Research something first"
          />
        )}
        {docs.map((doc) => (
          <article key={doc.id} className="surface p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{doc.title}</h2>
              <span className="badge">{doc.category}</span>
              <span className="badge">v{doc.version}</span>
              <span className="badge">{doc.status}</span>
              <span className="badge">{doc._count.chunks} chunks</span>
              <button
                className="btn btn-secondary ml-auto"
                type="button"
                onClick={async () => {
                  const res = await fetch("/api/knowledge", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      id: doc.id,
                      status: doc.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
                    }),
                  });
                  if (!res.ok) {
                    toast.error("Update failed");
                    return;
                  }
                  await load();
                }}
              >
                {doc.status === "ACTIVE" ? "Deactivate" : "Activate"}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={async () => {
                  const res = await fetch(`/api/knowledge?id=${encodeURIComponent(doc.id)}`, {
                    method: "DELETE",
                  });
                  if (!res.ok) {
                    toast.error("Archive failed");
                    return;
                  }
                  toast.success("Archived");
                  await load();
                }}
              >
                Archive
              </button>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm text-[var(--muted)] line-clamp-6">
              {doc.content}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
