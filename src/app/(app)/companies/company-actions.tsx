"use client";

import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { SlideOver } from "@/components/ui/slide-over";
import { getImmutableWorkspaceContext, workspaceFetch } from "@/lib/workspace-client";

export type EditableCompany = {
  id: string;
  name: string;
  domain: string | null;
  website?: string | null;
  industry: string | null;
  sizeBand?: string | null;
  _count?: { contacts: number; deals: number };
};

/** Edit a company's details (PATCH /api/companies/:id — org-scoped, leads:write). */
export function CompanyEditDrawer({
  company,
  onClose,
  onSaved,
}: {
  company: EditableCompany | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const workspaceContext = getImmutableWorkspaceContext(null);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [website, setWebsite] = useState("");
  const [industry, setIndustry] = useState("");
  const [sizeBand, setSizeBand] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!company) return;
    setName(company.name);
    setDomain(company.domain ?? "");
    setWebsite(company.website ?? "");
    setIndustry(company.industry ?? "");
    setSizeBand(company.sizeBand ?? "");
  }, [company]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!company) return;
    setSaving(true);
    try {
      const res = await workspaceFetch(
        workspaceContext.loadedOrganisationId,
        workspaceContext.workspaceRevision,
        `/api/companies/${encodeURIComponent(company.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            domain: domain.trim() || null,
            website: website.trim() || null,
            industry: industry.trim() || null,
            sizeBand: sizeBand.trim() || null,
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "Could not save the company");
        return;
      }
      toast.success("Company saved");
      await onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <SlideOver
      open={Boolean(company)}
      onClose={onClose}
      title="Edit company"
      description="Linked contacts and deals stay attached."
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        <label className="block text-sm font-medium">
          Name
          <input
            className="input mt-1 w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={200}
          />
        </label>
        <label className="block text-sm font-medium">
          Domain
          <input
            className="input mt-1 w-full"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="example.com"
          />
        </label>
        <label className="block text-sm font-medium">
          Website
          <input
            className="input mt-1 w-full"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://example.com"
          />
        </label>
        <label className="block text-sm font-medium">
          Industry
          <input
            className="input mt-1 w-full"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
          />
        </label>
        <label className="block text-sm font-medium">
          Size
          <input
            className="input mt-1 w-full"
            value={sizeBand}
            onChange={(e) => setSizeBand(e.target.value)}
            placeholder="e.g. 10-50"
          />
        </label>
        <div className="flex gap-2">
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save company"}
          </button>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </SlideOver>
  );
}

/**
 * Confirm, then soft-delete a company (DELETE /api/companies/:id). Its deals and contacts stay —
 * they are just no longer linked to it. Returns true when deleted.
 */
export async function confirmAndDeleteCompany(company: EditableCompany): Promise<boolean> {
  const links = company._count
    ? ` Its ${company._count.contacts} contact(s) and ${company._count.deals} deal(s) will be kept but no longer linked to it.`
    : " Its contacts and deals will be kept but no longer linked to it.";
  if (!window.confirm(`Delete the company "${company.name}"?${links}`)) return false;
  const workspaceContext = getImmutableWorkspaceContext(null);
  const res = await workspaceFetch(
    workspaceContext.loadedOrganisationId,
    workspaceContext.workspaceRevision,
    `/api/companies/${encodeURIComponent(company.id)}`,
    { method: "DELETE" },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast.error(json.error || "Could not delete the company");
    return false;
  }
  toast.success("Company deleted");
  return true;
}
