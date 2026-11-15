"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type BookingWebhookStatus = {
  organisationId: string;
  secretConfigured: boolean;
  secretMasked: string;
  sharedSecretAccepted: boolean;
  header: string;
  webhookUrls: { generic: string; calendly: string; calcom: string };
};

/** Workspace-owned booking webhook secret (replaces the old shared secret). */
export function BookingWebhookCard() {
  const [status, setStatus] = useState<BookingWebhookStatus | null>(null);
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/integrations/booking");
    if (res.status === 403) {
      setHidden(true);
      return;
    }
    if (res.ok) setStatus(await res.json());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function regenerate() {
    if (
      status?.secretConfigured &&
      !window.confirm(
        "Generate a new booking secret? Your booking tool will stop being accepted until you paste the new one into it.",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "regenerate_secret" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not generate secret");
      setOneTimeSecret(json.secret);
      toast.success("Secret generated — copy it now, it is only shown once");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not generate secret");
    } finally {
      setBusy(false);
    }
  }

  function copy(value: string) {
    void navigator.clipboard?.writeText(value).then(
      () => toast.success("Copied"),
      () => toast.error("Copy failed"),
    );
  }

  if (hidden) return null;

  return (
    <section className="surface space-y-3 p-5">
      <div>
        <h2 className="text-lg font-semibold">Booking confirmations</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          When a lead books through your calendar tool, it tells Agent Desk here — the lead moves to
          Booked and follow-ups stop. Send the header <code>{status?.header ?? "x-booking-secret"}</code>{" "}
          with your workspace secret and include <code>organisationId</code> in the body.
        </p>
      </div>
      {status && !status.secretConfigured && (
        <p className="rounded-lg bg-[var(--surface-2)] p-3 text-sm">
          {status.sharedSecretAccepted
            ? "This workspace still uses the shared booking secret. Generate your own so only your calendar tool can update your pipeline, then paste it into the tool."
            : "Generate a booking secret — booking confirmations are refused until this workspace has one."}
        </p>
      )}
      <dl className="grid gap-3 text-sm md:grid-cols-2">
        <div>
          <dt className="text-[var(--muted)]">Webhook URL</dt>
          <dd className="mt-1 break-all font-mono text-xs">{status?.webhookUrls.generic ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">organisationId</dt>
          <dd className="mt-1 break-all font-mono text-xs">{status?.organisationId ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">Workspace secret</dt>
          <dd className="mt-1 font-mono text-xs">
            {status?.secretConfigured ? status.secretMasked : "not set"}
          </dd>
        </div>
      </dl>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void regenerate()}>
        {status?.secretConfigured ? "Regenerate secret" : "Generate secret"}
      </button>
      {oneTimeSecret && (
        <p className="rounded-lg bg-[var(--surface-2)] p-2 font-mono text-xs">
          New secret (shown once): {oneTimeSecret}
          <button type="button" className="btn btn-secondary ml-2" onClick={() => copy(oneTimeSecret)}>
            Copy
          </button>
        </p>
      )}
    </section>
  );
}
