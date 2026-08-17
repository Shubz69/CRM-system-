"use client";

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

export default function QualificationPage() {
  const [fields, setFields] = useState<Field[]>([]);
  const [form, setForm] = useState(blank);
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
    const data = await response.json();
    if (!response.ok) return toast.error(data.error || "Failed");
    setForm(blank);
    await load();
    toast.success("Field created");
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
              className="btn btn-secondary"
              onClick={async () => {
                const response = await fetch(`/api/qualification-fields?id=${field.id}`, { method: "DELETE" });
                if (!response.ok) toast.error("Unable to deactivate");
                else void load();
              }}
            >
              Deactivate
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}
