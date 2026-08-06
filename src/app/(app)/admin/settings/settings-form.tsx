"use client";

import { FormEvent, useState } from "react";
import { toast } from "sonner";

export function GlobalSettingsForm({
  initial,
}: {
  initial: Array<{ key: string; value: unknown }>;
}) {
  const [rows, setRows] = useState(initial);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("{}");

  async function save(e: FormEvent) {
    e.preventDefault();
    let parsed: unknown = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      toast.error("Value must be valid JSON");
      return;
    }
    const res = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value: parsed }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Save failed");
      return;
    }
    toast.success("Setting saved");
    setRows((prev) => {
      const without = prev.filter((r) => r.key !== key);
      return [...without, { key, value: parsed }].sort((a, b) => a.key.localeCompare(b.key));
    });
    setKey("");
    setValue("{}");
  }

  return (
    <div className="space-y-4">
      <div className="surface overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3">Key</th>
              <th className="px-4 py-3">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-6 text-[var(--muted)]">
                  No settings yet.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-[var(--border)]/60">
                <td className="px-4 py-3 font-mono text-xs">{row.key}</td>
                <td className="px-4 py-3 font-mono text-xs">
                  {JSON.stringify(row.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form onSubmit={save} className="surface grid gap-3 p-4 md:grid-cols-3">
        <label className="text-sm">
          Key
          <input className="input mt-1" value={key} onChange={(e) => setKey(e.target.value)} required />
        </label>
        <label className="text-sm md:col-span-2">
          JSON value
          <input className="input mt-1 font-mono" value={value} onChange={(e) => setValue(e.target.value)} required />
        </label>
        <button className="btn btn-primary md:col-span-3" type="submit">
          Save setting
        </button>
      </form>
    </div>
  );
}
