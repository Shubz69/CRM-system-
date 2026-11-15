"use client";

import { PermissionGate } from "@/components/permission-gate";
import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";

type Field = {
  id: string;
  key: string;
  label: string;
  fieldType: string;
  required: boolean;
  weight: number;
  position: number;
  options: string[];
  disqualifyingAnswers: string[];
  active: boolean;
};
const blank = {
  key: "",
  label: "",
  fieldType: "short_text",
  required: false,
  weight: 10,
  position: 0,
  options: "",
  disqualifyingAnswers: "",
};

function QualificationPageContent() {
  const [fields, setFields] = useState<Field[]>([]);
  const [form, setForm] = useState(blank);
  const [busyId, setBusyId] = useState<string | null>(null);
  const load = async () => {
    const response = await fetch("/api/qualification-fields");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed");
    setFields(data.fields);
  };
  useEffect(() => {
    load().catch((error) => toast.error(error.message));
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/qualification-fields", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        weight: Number(form.weight),
        position: Number(form.position),
        options: form.options
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        disqualifyingAnswers: form.disqualifyingAnswers
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return toast.error(data.error || "Couldn't create the field");
    setForm(blank);
    await load();
    toast.success("Field created");
  }

  async function setActive(field: Field, active: boolean) {
    setBusyId(field.id);
    try {
      const response = active
        ? await fetch("/api/qualification-fields", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: field.id, active: true }),
          })
        : await fetch(`/api/qualification-fields?id=${encodeURIComponent(field.id)}`, {
            method: "DELETE",
          });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(data.error || (active ? "Unable to reactivate" : "Unable to deactivate"));
        return;
      }
      toast.success(active ? `“${field.label}” reactivated` : `“${field.label}” deactivated`);
      await load();
    } catch {
      toast.error(active ? "Unable to reactivate" : "Unable to deactivate");
    } finally {
      setBusyId(null);
    }
  }
  return (
    <div className="space-y-6">
      <PageHeader description="Configure the information your agent collects and scores." />
      <form className="surface grid gap-3 p-5 md:grid-cols-2" onSubmit={save}>
        {(["key", "label", "fieldType", "weight", "position", "options", "disqualifyingAnswers"] as const).map(
          (key) => (
            <label key={key} className="text-sm">
              {key.replace(/([A-Z])/g, " $1")}
              <input
                className="input mt-1"
                value={String(form[key])}
                type={key === "weight" || key === "position" ? "number" : "text"}
                onChange={(event) => setForm({ ...form, [key]: event.target.value })}
              />
            </label>
          ),
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.required}
            onChange={(event) => setForm({ ...form, required: event.target.checked })}
          />{" "}
          Required
        </label>
        <div className="flex items-end">
          <button className="btn btn-primary" type="submit">
            Create field
          </button>
        </div>
      </form>
      <div className="grid gap-3">
        {fields.map((field) => (
          <article key={field.id} className="surface flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <h2 className="font-semibold">
                {field.label} <span className="text-sm text-[var(--muted)]">({field.key})</span>
              </h2>
              <p className="text-sm text-[var(--muted)]">
                {field.fieldType} · weight {field.weight} · {field.required ? "required" : "optional"} ·{" "}
                {field.active ? "active" : "inactive"}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busyId === field.id}
              onClick={() => void setActive(field, !field.active)}
            >
              {field.active ? "Deactivate" : "Reactivate"}
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}

export default function QualificationPage() {
  return (
    <PermissionGate
      permission="agent:manage"
      title="Qualification"
      message="Only workspace owners and admins change the qualification questions."
    >
      <QualificationPageContent />
    </PermissionGate>
  );
}
