"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";

type Channel = {
  id: string;
  provider: string;
  externalId: string | null;
  displayName: string;
  instagramUsername: string | null;
  isActive: boolean;
};

type ManyChatStatus = {
  webhookUrl: string;
  inboundAliasUrl?: string;
  secretConfigured: boolean;
  secretMasked: string;
  secretSource?: string;
  apiTokenConfigured: boolean;
  apiTokenStatus?: "Configured" | "Not configured";
  apiTokenMasked?: string;
  connectionActive?: boolean;
  channels: Channel[];
  connected: boolean;
  lastInboundEvent?: {
    id: string;
    eventType: string | null;
    status: string;
    receivedAt: string;
  } | null;
  recentErrors?: Array<{ id: string; error: string | null; status: string; receivedAt: string }>;
  setup?: {
    requiredHeaders: string[];
    requiredFields: string[];
    optionalFields: string[];
    examplePayload: Record<string, unknown>;
  };
};

type ReadinessStatus = "ready" | "untested" | "failed" | "missing" | "test_mode";

type IntegrationReadiness = {
  id: string;
  label: string;
  description: string;
  status: ReadinessStatus;
  statusLabel: string;
  configured: boolean;
  usingTestMode: boolean;
  detail: string;
  lastTest: { ok: boolean; testedAt: string; message: string } | null;
};

type ReadinessPayload = {
  items: IntegrationReadiness[];
  goLiveReady: boolean;
  summary: string;
};

type SocialCapabilities = { listen: boolean; publish: boolean; message: boolean };

type SocialConnectionSummary = {
  id: string;
  displayName: string | null;
  status: "PENDING" | "ACTIVE" | "EXPIRED" | "REVOKED" | "ERROR";
  scopes: string[];
  expiresAt: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
};

type SocialPlatformStatus = {
  platform: "INSTAGRAM" | "LINKEDIN" | "TIKTOK";
  slug: string;
  displayName: string;
  capabilities: SocialCapabilities;
  configured: boolean;
  connection: SocialConnectionSummary | null;
};

type MetaInstagramStatus = {
  appConfigured: boolean;
  connection: {
    configured: boolean;
    isActive: boolean;
    health: string;
    username: string | null;
    igUserId: string | null;
    scopes: string[];
    webhookSubscribed: boolean;
    connectedAt: string | null;
    lastValidatedAt: string | null;
    duplicateManyChatRisk: boolean;
  };
  reconnectHint: string | null;
};

/**
 * Messaging for Instagram: native Meta path or ManyChat below.
 * LinkedIn / TikTok have no compliant third-party DM API.
 */
function messagingNote(slug: string): string {
  if (slug === "instagram") return "via Meta (Connect above) or ManyChat (below)";
  return "not available — no third-party API exists";
}

function statusBadgeClass(status: ReadinessStatus): string {
  switch (status) {
    case "ready":
      return "badge badge-success";
    case "untested":
      return "badge badge-warn";
    case "failed":
      return "badge badge-danger";
    case "test_mode":
      return "badge badge-warn";
    case "missing":
    default:
      return "badge";
  }
}

function formatTestedAt(iso: string | undefined | null): string {
  if (!iso) return "Never tested";
  try {
    return `Last tested ${new Date(iso).toLocaleString()}`;
  } catch {
    return "Last tested —";
  }
}

const MANYCHAT_SETUP_ID = "manychat-setup";

export default function IntegrationsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const manychatSetupRef = useRef<HTMLElement | null>(null);
  const apiTokenInputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<ManyChatStatus | null>(null);
  const [metaIg, setMetaIg] = useState<MetaInstagramStatus | null>(null);
  const [ayrshare, setAyrshare] = useState<{
    configured?: boolean;
    serverConfigured?: boolean;
    status?: string;
  } | null>(null);
  const [socialAccounts, setSocialAccounts] = useState<{
    serverConfigured?: boolean;
    status?: string;
    networks?: {
      instagram?: { connected?: boolean; requiresFacebookPage?: boolean };
      linkedin?: { connected?: boolean; dmCapability?: string };
    };
    connectedAccounts?: Array<{ platform?: string; displayName?: string }>;
  } | null>(null);
  const [metaTestContactId, setMetaTestContactId] = useState("");
  const [metaTestConversationId, setMetaTestConversationId] = useState("");
  const [metaTestText, setMetaTestText] = useState("");
  const [readiness, setReadiness] = useState<ReadinessPayload | null>(null);
  const [socialPlatforms, setSocialPlatforms] = useState<SocialPlatformStatus[] | null>(null);
  const [externalId, setExternalId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [channelActive, setChannelActive] = useState(true);
  const [apiTokenInput, setApiTokenInput] = useState("");
  const [testContactExternalId, setTestContactExternalId] = useState("");
  const [testMessageText, setTestMessageText] = useState("");
  const [loading, setLoading] = useState(true);
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAdvancedMesh, setShowAdvancedMesh] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [aiReady, setAiReady] = useState(false);
  const [mesh, setMesh] = useState<{
    connectors: Array<{
      providerKey: string;
      displayName: string;
      connectionStatus: string;
      customerLabel: string;
      capabilities: Array<{
        capability: string;
        status: string;
        provenance: string;
        missingScopes: string[];
        detail?: string;
      }>;
    }>;
    recentSyncs: Array<{
      id: string;
      providerKey: string;
      resource: string;
      status: string;
      processedCount: number;
      startedAt: string;
    }>;
    limitations: string[];
  } | null>(null);

  const loadReadiness = useCallback(async () => {
    const res = await fetch("/api/integrations/connection-tests");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Could not load readiness");
    setReadiness(json);
  }, []);

  const loadAyrshare = useCallback(async () => {
    const res = await fetch("/api/integrations/ayrshare");
    if (!res.ok) {
      setAyrshare(null);
      return;
    }
    setAyrshare(await res.json());
  }, []);

  const loadSocialAccounts = useCallback(async () => {
    const res = await fetch("/api/integrations/zernio");
    if (!res.ok) {
      setSocialAccounts(null);
      return;
    }
    setSocialAccounts(await res.json());
  }, []);

  const loadManyChat = useCallback(async () => {
    const res = await fetch("/api/integrations/manychat");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load");
    setStatus(json);
  }, []);

  const loadMetaInstagram = useCallback(async () => {
    const res = await fetch("/api/integrations/meta-instagram");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load Instagram (Meta)");
    setMetaIg(json);
  }, []);

  const loadSocial = useCallback(async () => {
    const res = await fetch("/api/social/connections");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Could not load social connections");
    setSocialPlatforms(json.platforms);
  }, []);

  const loadMesh = useCallback(async () => {
    const res = await fetch("/api/integrations/mesh");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Could not load integration mesh");
    setMesh(json);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const providersPromise = fetch("/api/health/providers");
      await Promise.all([
        loadManyChat(),
        loadMetaInstagram(),
        loadAyrshare(),
        loadSocialAccounts(),
        loadReadiness(),
        loadSocial(),
        loadMesh(),
      ]);
      const providersRes = await providersPromise;
      if (providersRes.ok) {
        const p = await providersRes.json();
        setAiReady(Boolean(p.providers?.ai?.ready || p.providers?.ai?.hasAnthropicKey));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }, [loadManyChat, loadMetaInstagram, loadAyrshare, loadSocialAccounts, loadReadiness, loadSocial, loadMesh]);

  useEffect(() => {
    void load();
  }, [load]);

  const focusManyChatSetup = useCallback((opts?: { focusToken?: boolean }) => {
    const el = manychatSetupRef.current || document.getElementById(MANYCHAT_SETUP_ID);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    if (typeof el.focus === "function") {
      el.focus({ preventScroll: true });
    }
    if (opts?.focusToken) {
      window.setTimeout(() => apiTokenInputRef.current?.focus(), 350);
    }
  }, []);

  // One journey: Instagram Configure / Set up → ManyChat setup section.
  useEffect(() => {
    if (loading) return;
    const setup = searchParams.get("setup");
    const hash =
      typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
    if (setup === "manychat" || hash === MANYCHAT_SETUP_ID) {
      focusManyChatSetup({ focusToken: setup === "manychat" });
    }
  }, [loading, searchParams, focusManyChatSetup]);

  // /api/social/[platform]/callback and Meta Instagram OAuth redirect here —
  // surface once, then strip from the URL so a refresh doesn't repeat it.
  useEffect(() => {
    const connected = searchParams.get("social_connected");
    const error = searchParams.get("social_error");
    const metaStatus = searchParams.get("meta_instagram");
    const metaError = searchParams.get("meta_instagram_error");
    if (!connected && !error && !metaStatus) return;
    if (connected) toast.success(`${connected} connected`);
    if (error) toast.error(error);
    if (metaStatus === "connected") toast.success("Instagram messaging connected");
    else if (metaStatus === "incomplete")
      toast.error(metaError || "Instagram connected but setup is incomplete");
    else if (metaStatus === "not_configured")
      toast.error("Meta Instagram app is not configured on the server");
    else if (metaStatus === "denied") toast.error(metaError || "Instagram connection denied");
    else if (metaStatus === "error") toast.error(metaError || "Instagram connection failed");
    if (metaStatus === "connected" || metaStatus === "incomplete") {
      void loadMetaInstagram();
    }
    router.replace("/integrations");
  }, [searchParams, router, loadMetaInstagram]);

  async function disconnectSocial(id: string) {
    setDisconnectingId(id);
    try {
      const res = await fetch(`/api/social/connections/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not disconnect");
      toast.success("Disconnected");
      await loadSocial();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not disconnect");
    } finally {
      setDisconnectingId(null);
    }
  }

  async function saveChannel(e: FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/messaging-channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "manychat",
        externalId,
        displayName: displayName || externalId,
        isActive: channelActive,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Save failed");
      return;
    }
    toast.success("Messaging channel saved");
    setExternalId("");
    setDisplayName("");
    setChannelActive(true);
    await load();
  }

  async function manychatAction(action: string, payload: Record<string, unknown> = {}) {
    const res = await fetch("/api/integrations/manychat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Request failed");
    return json;
  }

  async function metaInstagramAction(action: string, payload: Record<string, unknown> = {}) {
    const res = await fetch("/api/integrations/meta-instagram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Request failed");
    return json;
  }

  async function saveApiToken(e: FormEvent) {
    e.preventDefault();
    if (!apiTokenInput.trim()) {
      toast.error("Paste your ManyChat API token first");
      return;
    }
    setBusy(true);
    try {
      const json = await manychatAction("save_api_token", { apiToken: apiTokenInput.trim() });
      setApiTokenInput("");
      toast.success(json.message || "API token saved");
      await loadManyChat();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save token");
    } finally {
      setBusy(false);
    }
  }

  async function disconnectManyChat() {
    setBusy(true);
    try {
      const json = await manychatAction("disconnect");
      toast.success(json.message || "ManyChat disconnected");
      await loadManyChat();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not disconnect");
    } finally {
      setBusy(false);
    }
  }

  async function reconnectManyChat() {
    setBusy(true);
    try {
      const json = await manychatAction("reconnect");
      toast.success(json.message || "ManyChat reconnected");
      await loadManyChat();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reconnect");
    } finally {
      setBusy(false);
    }
  }

  async function validateConfiguration() {
    setBusy(true);
    try {
      const json = await manychatAction("validate_configuration");
      if (json.ok) toast.success(json.message || "Configuration valid — no message sent");
      else toast.error(json.message || "Configuration incomplete");
      await loadManyChat();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Validation failed");
    } finally {
      setBusy(false);
    }
  }

  async function sendTestMessage(e: FormEvent) {
    e.preventDefault();
    if (!testContactExternalId.trim()) {
      toast.error("Enter a real ManyChat subscriber ID");
      return;
    }
    setBusy(true);
    try {
      const json = await manychatAction("send_test_message", {
        contactExternalId: testContactExternalId.trim(),
        text: testMessageText.trim() || undefined,
      });
      if (json.ok) toast.success(json.message || "Test message sent");
      else toast.error(json.message || "Test message failed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test message failed");
    } finally {
      setBusy(false);
    }
  }

  async function regenerateSecret() {
    setBusy(true);
    try {
      const json = await manychatAction("regenerate_secret");
      if (json.secret) {
        setOneTimeSecret(json.secret);
        toast.success("Secret regenerated — copy it now");
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not regenerate secret");
    } finally {
      setBusy(false);
    }
  }

  async function simulateInbound() {
    setBusy(true);
    try {
      await manychatAction("test_inbound");
      toast.success("Sample inbound message processed inside the CRM (nothing sent to Instagram)");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Simulation failed");
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(id: string) {
    setTestingId(id);
    try {
      const res = await fetch("/api/integrations/connection-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integration: id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Connection test failed");
      if (json.ok) toast.success(json.message);
      else toast.error(json.message);
      await loadReadiness();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Connection test failed");
    } finally {
      setTestingId(null);
    }
  }

  async function testAll() {
    if (!readiness) return;
    for (const item of readiness.items) {
      await testConnection(item.id);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy");
    }
  }

  if (loading && !status && !readiness) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading integrations">
        <div className="h-8 w-48 animate-pulse rounded-lg bg-[var(--surface-2)]" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="surface space-y-3 p-4">
              <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--surface-2)]" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--surface-2)]" />
              <div className="mt-4 h-6 w-24 animate-pulse rounded-full bg-[var(--surface-2)]" />
            </div>
          ))}
        </div>
        <div className="surface space-y-3 p-5">
          <div className="h-4 w-40 animate-pulse rounded bg-[var(--surface-2)]" />
          <div className="h-3 w-full animate-pulse rounded bg-[var(--surface-2)]" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-[var(--surface-2)]" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader description="Connect channels, finish setup, and go live — advanced detail stays out of the way." />

      <section className="surface space-y-4 p-5">
        <h2 className="font-[family-name:var(--font-fraunces)] text-lg">Connected channels</h2>
        <p className="text-sm text-[var(--muted)]">
          What is live for this workspace right now.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-xl border border-[var(--border)] p-4">
            <p className="font-medium">Instagram messaging</p>
            <p className="mt-1 text-xs text-[var(--muted)]">DMs into the same Inbox</p>
            <p className="mt-3 text-sm">
              {metaIg?.connection?.health === "CONNECTED" || status?.connected ? (
                <span className="badge badge-success">Connected</span>
              ) : (
                <span className="badge badge-warn">Needs setup</span>
              )}
            </p>
            {metaIg?.connection?.username ? (
              <p className="mt-1 text-xs text-[var(--muted)]">@{metaIg.connection.username}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {metaIg?.appConfigured ? (
                <a
                  href="/api/integrations/meta-instagram/connect"
                  className="btn btn-primary text-xs"
                >
                  Connect with Instagram
                </a>
              ) : null}
              <button
                type="button"
                className="btn btn-secondary text-xs"
                onClick={() => focusManyChatSetup({ focusToken: true })}
              >
                Set up with ManyChat
              </button>
            </div>
          </div>
          <div className="rounded-xl border border-[var(--border)] p-4">
            <p className="font-medium">Social Accounts</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Connect Instagram (Business/Creator — Instagram Login, no Facebook Page required) and
              LinkedIn for publishing and analytics. Prospect outreach stays Open + Copy.
            </p>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  Instagram{" "}
                  {socialAccounts?.networks?.instagram?.connected ? (
                    <span className="badge badge-success">Connected</span>
                  ) : (
                    <span className="badge">Not connected</span>
                  )}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary text-xs"
                  disabled={busy || !socialAccounts?.serverConfigured}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const res = await fetch("/api/integrations/zernio", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "connect", platform: "instagram" }),
                      });
                      const json = await res.json();
                      if (!res.ok) throw new Error(json.error || "Could not start Instagram connect");
                      if (json.url) {
                        window.location.href = json.url;
                        return;
                      }
                      toast.success("Connect ready");
                      await loadSocialAccounts();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Connect failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Connect
                </button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  LinkedIn{" "}
                  {socialAccounts?.networks?.linkedin?.connected ? (
                    <span className="badge badge-success">Connected</span>
                  ) : (
                    <span className="badge">Not connected</span>
                  )}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary text-xs"
                  disabled={busy || !socialAccounts?.serverConfigured}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const res = await fetch("/api/integrations/zernio", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "connect", platform: "linkedin" }),
                      });
                      const json = await res.json();
                      if (!res.ok) throw new Error(json.error || "Could not start LinkedIn connect");
                      if (json.url) {
                        window.location.href = json.url;
                        return;
                      }
                      toast.success("Connect ready");
                      await loadSocialAccounts();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Connect failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Connect
                </button>
              </div>
              {!socialAccounts?.serverConfigured ? (
                <p className="text-xs text-[var(--muted)]">Social account linking is not configured on this server.</p>
              ) : null}
            </div>
          </div>
          {ayrshare?.serverConfigured || ayrshare?.configured ? (
            <div className="rounded-xl border border-[var(--border)] p-4">
              <p className="font-medium">Additional social provider</p>
              <p className="mt-1 text-xs text-[var(--muted)]">Optional alternate connect path for multi-network publish</p>
              <p className="mt-3 text-sm">
                {ayrshare?.status === "CONNECTED" ? (
                  <span className="badge badge-success">Connected</span>
                ) : (
                  <span className="badge">Configured</span>
                )}
              </p>
              <button
                type="button"
                className="btn btn-secondary mt-3 text-xs"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const res = await fetch("/api/integrations/ayrshare", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "create_social_link" }),
                    });
                    const json = await res.json();
                    if (!res.ok) throw new Error(json.error || "Could not start social link");
                    if (json.url) {
                      window.location.href = json.url;
                      return;
                    }
                    toast.success("Social link ready");
                    await loadAyrshare();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Link failed");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Connect alternate provider
              </button>
            </div>
          ) : null}
          <div className="rounded-xl border border-[var(--border)] p-4">
            <p className="font-medium">AI provider</p>
            <p className="mt-1 text-xs text-[var(--muted)]">Qualification, replies, analysis</p>
            <p className="mt-3">
              <Link href="/agent" className="btn btn-secondary text-xs">
                Manage AI behaviour
              </Link>
            </p>
          </div>
          <div className="rounded-xl border border-[var(--border)] p-4">
            <p className="font-medium">Booking</p>
            <p className="mt-1 text-xs text-[var(--muted)]">Meeting links and confirmed bookings</p>
            <p className="mt-3">
              <Link href="/agent" className="btn btn-secondary text-xs">
                Configure booking
              </Link>
            </p>
          </div>
        </div>
      </section>

      {mesh && (
        <section className="surface space-y-3 p-4">
          <button
            type="button"
            className="flex w-full items-center justify-between text-left"
            onClick={() => setShowAdvancedMesh((v) => !v)}
          >
            <span>
              <span className="font-semibold">Advanced connector details</span>
              <span className="mt-0.5 block text-xs text-[var(--muted)]">
                Capability matrix for operators — not required for day-to-day setup
              </span>
            </span>
            <span className="text-xs text-[var(--muted)]">
              {showAdvancedMesh ? "Hide" : "Show"}
            </span>
          </button>
          {showAdvancedMesh ? (
            <div className="space-y-4 border-t border-[var(--border)] pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">Connector mesh</h2>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={async () => {
                    try {
                      const res = await fetch("/api/integrations/mesh", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "refresh_capabilities" }),
                      });
                      const json = await res.json();
                      if (!res.ok) throw new Error(json.error || "Refresh failed");
                      toast.success("Capabilities refreshed from live connection state");
                      await loadMesh();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Refresh failed");
                    }
                  }}
                >
                  Refresh capabilities
                </button>
              </div>
              <p className="text-sm text-[var(--muted)]">
                Connected ≠ all capabilities available. Statuses come from credentials, scopes, and
                provider restrictions — never invented.
              </p>
              <div className="space-y-3">
                {mesh.connectors.map((c) => (
                  <div key={c.providerKey} className="rounded border border-border p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="font-medium">{c.displayName}</h3>
                      <span className="text-xs uppercase tracking-wide">{c.customerLabel}</span>
                    </div>
                    <p className="text-xs text-[var(--muted)]">
                      {c.providerKey} · connection {c.connectionStatus}
                    </p>
                    <ul className="mt-2 space-y-1 text-sm">
                      {c.capabilities.map((cap) => (
                        <li key={cap.capability} className="flex flex-wrap gap-2">
                          <span className="min-w-[10rem] font-medium">{cap.capability}</span>
                          <span className="text-xs uppercase">{cap.status}</span>
                          <span className="text-[var(--muted)]">{cap.provenance}</span>
                          {cap.missingScopes?.length ? (
                            <span className="text-xs">missing: {cap.missingScopes.join(", ")}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <div className="surface p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">Instagram</h2>
            <span
              className={
                metaIg?.connection?.health === "CONNECTED" || status?.connected
                  ? "badge"
                  : "badge badge-warn"
              }
            >
              {metaIg?.connection?.health === "CONNECTED"
                ? "Meta Connected"
                : status?.connected
                  ? "ManyChat Connected"
                  : "Not Connected"}
            </span>
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Native Meta DMs or ManyChat — same Inbox
          </p>
          {metaIg?.connection?.username ? (
            <p className="mt-1 text-xs text-[var(--muted)]">
              @{metaIg.connection.username}
              {metaIg.connection.health ? ` · ${metaIg.connection.health}` : ""}
            </p>
          ) : metaIg && !metaIg.appConfigured ? (
            <p className="mt-1 text-xs text-[var(--muted)]">Meta app not configured on server</p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {metaIg?.appConfigured ? (
              <a href="/api/integrations/meta-instagram/connect" className="btn btn-primary">
                Connect with Instagram
              </a>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => focusManyChatSetup({ focusToken: !status?.apiTokenConfigured })}
            >
              Set up with ManyChat
            </button>
          </div>
          {metaIg?.connection?.isActive || metaIg?.connection?.health === "CONNECTED" ? (
            <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-3">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-secondary text-xs"
                  disabled={busy}
                  onClick={() => {
                    void (async () => {
                      setBusy(true);
                      try {
                        const json = await metaInstagramAction("validate_configuration");
                        toast.success(json.message || json.status || "Validated");
                        await loadMetaInstagram();
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Validate failed");
                      } finally {
                        setBusy(false);
                      }
                    })();
                  }}
                >
                  Validate
                </button>
                <button
                  type="button"
                  className="btn btn-secondary text-xs"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm("Disconnect Instagram (Meta)? History is kept; outbound stops.")) {
                      return;
                    }
                    void (async () => {
                      setBusy(true);
                      try {
                        const json = await metaInstagramAction("disconnect");
                        toast.success(json.message || "Disconnected");
                        await loadMetaInstagram();
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Disconnect failed");
                      } finally {
                        setBusy(false);
                      }
                    })();
                  }}
                >
                  Disconnect
                </button>
              </div>
              <p className="text-xs text-[var(--muted)]">
                Test message sends a real Instagram DM — requires contactId + conversationId with
                prior inbound.
              </p>
              <div className="flex flex-wrap gap-2">
                <input
                  className="input text-xs"
                  placeholder="contactId"
                  value={metaTestContactId}
                  onChange={(e) => setMetaTestContactId(e.target.value)}
                />
                <input
                  className="input text-xs"
                  placeholder="conversationId"
                  value={metaTestConversationId}
                  onChange={(e) => setMetaTestConversationId(e.target.value)}
                />
                <input
                  className="input text-xs"
                  placeholder="Optional message"
                  value={metaTestText}
                  onChange={(e) => setMetaTestText(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-primary text-xs"
                  disabled={busy}
                  onClick={() => {
                    if (!metaTestContactId.trim() || !metaTestConversationId.trim()) {
                      toast.error("contactId and conversationId are required");
                      return;
                    }
                    if (
                      !confirm(
                        "Send a real Instagram DM via Meta? This uses the live outbound path.",
                      )
                    ) {
                      return;
                    }
                    void (async () => {
                      setBusy(true);
                      try {
                        const json = await metaInstagramAction("send_test_message", {
                          contactId: metaTestContactId.trim(),
                          conversationId: metaTestConversationId.trim(),
                          text: metaTestText.trim() || undefined,
                        });
                        if (json.ok) toast.success(json.message || "Test sent");
                        else toast.error(json.message || "Test not sent");
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Test failed");
                      } finally {
                        setBusy(false);
                      }
                    })();
                  }}
                >
                  Send test message
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="surface p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">Calendar</h2>
            <span className="badge">Booking URL</span>
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">Manage in AI Operator / Settings</p>
          <Link href="/agent" className="btn btn-secondary mt-3">
            Manage
          </Link>
        </div>
        <div className="surface p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">AI Operator</h2>
            <span className={aiReady ? "badge" : "badge badge-warn"}>
              {aiReady ? "Claude Connected" : "Claude Needs Setup"}
            </span>
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">Anthropic Claude — OpenAI not required</p>
          <Link href="/agent" className="btn btn-secondary mt-3">
            Manage
          </Link>
        </div>
      </div>

      <section className="surface space-y-4 p-5">
        <div>
          <h2 className="h-display text-2xl">Social Connections</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Connect your own Instagram, LinkedIn, or TikTok account for listening and publishing.
            What each platform can actually do differs — badges below reflect each platform&apos;s
            real, current API limits, not a wishlist.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {(socialPlatforms || []).map((p) => {
            const connected = p.connection && p.connection.status === "ACTIVE";
            return (
              <div key={p.platform} className="surface p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold">{p.displayName}</h3>
                  <span className={connected ? "badge badge-success" : "badge badge-warn"}>
                    {connected ? "Connected" : "Not connected"}
                  </span>
                </div>
                {connected && (
                  <p className="mt-1 text-sm text-[var(--muted)]">{p.connection?.displayName}</p>
                )}
                <ul className="mt-3 space-y-1 text-xs text-[var(--muted)]">
                  <li>Listen (research/mentions): {p.capabilities.listen ? "Yes" : "No"}</li>
                  <li>Publish (post content): {p.capabilities.publish ? "Yes" : "No"}</li>
                  <li>Messaging: {messagingNote(p.slug)}</li>
                </ul>
                <div className="mt-3">
                  {connected ? (
                    <button
                      type="button"
                      className="btn btn-secondary w-full"
                      disabled={disconnectingId === p.connection?.id}
                      onClick={() => p.connection && void disconnectSocial(p.connection.id)}
                    >
                      {disconnectingId === p.connection?.id ? "Disconnecting…" : "Disconnect"}
                    </button>
                  ) : p.configured ? (
                    // Full browser navigation on purpose — this hits a server route that
                    // redirects to the OAuth provider, not an internal Next.js page.
                    <a href={`/api/social/${p.slug}/connect`} className="btn btn-primary w-full text-center">
                      {`Connect ${p.displayName}`}
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary w-full"
                      disabled
                      title="App credentials not configured yet — see docs/SOCIAL_CONNECTIONS.md"
                    >
                      Not set up yet
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {!socialPlatforms && (
            <p className="text-sm text-[var(--muted)]">Loading social connections…</p>
          )}
        </div>
      </section>

      {readiness && (
        <section className="surface space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="h-display text-2xl">Go-live readiness</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">{readiness.summary}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={readiness.goLiveReady ? "badge badge-success" : "badge badge-warn"}>
                {readiness.goLiveReady ? "Ready to go live" : "Not ready yet"}
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={Boolean(testingId)}
                onClick={() => void testAll()}
              >
                Test all
              </button>
            </div>
          </div>

          <ul className="divide-y divide-[var(--border)]/60">
            {readiness.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{item.label}</p>
                    <span className={statusBadgeClass(item.status)}>{item.statusLabel}</span>
                  </div>
                  <p className="mt-1 text-sm text-[var(--muted)]">{item.description}</p>
                  <p className="mt-1 text-sm">{item.detail}</p>
                  {item.lastTest && (
                    <p
                      className={`mt-1 text-xs ${item.lastTest.ok ? "text-[var(--muted)]" : "text-[var(--danger)]"}`}
                    >
                      {formatTestedAt(item.lastTest.testedAt)}
                      {" · "}
                      {item.lastTest.ok ? "Passed" : "Failed"}: {item.lastTest.message}
                    </p>
                  )}
                  {!item.lastTest && (
                    <p className="mt-1 text-xs text-[var(--muted)]">Never tested</p>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-primary shrink-0"
                  disabled={testingId === item.id}
                  onClick={() => void testConnection(item.id)}
                >
                  {testingId === item.id ? "Testing…" : "Test connection"}
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--muted)]">
            Tests make one small check only — they never message a real person. Mock adapters stay
            available for local testing; live mode never switches to mock silently when credentials
            are present.
          </p>
        </section>
      )}

      <section
        id={MANYCHAT_SETUP_ID}
        ref={manychatSetupRef}
        tabIndex={-1}
        className="surface scroll-mt-24 space-y-4 p-5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="h-display text-2xl">ManyChat setup</h2>
            <p className="text-sm text-[var(--muted)]">
              Connect Instagram DMs to Agent Desk through ManyChat — one guided path from account to
              first verified message.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={status?.connected ? "badge badge-success" : "badge badge-warn"}>
              {status?.connected ? "Connected" : "Not connected"}
            </span>
            {status?.connectionActive === false && (
              <span className="badge badge-warn">Disconnected</span>
            )}
          </div>
        </div>

        <ol className="list-decimal space-y-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-4 pl-8 text-sm text-[var(--muted)]">
          <li>
            <span className="font-medium text-[var(--foreground)]">Start in ManyChat</span> — open
            your Instagram-connected ManyChat account (or connect Instagram inside ManyChat first).
          </li>
          <li>
            <span className="font-medium text-[var(--foreground)]">Paste your API token</span> — from
            ManyChat Settings → API, save it below. We store it encrypted and never show it again.
          </li>
          <li>
            <span className="font-medium text-[var(--foreground)]">Copy the webhook URL</span> — Agent
            Desk listens here for inbound Instagram DMs.
          </li>
          <li>
            <span className="font-medium text-[var(--foreground)]">Set the webhook secret</span> —
            regenerate below, then add header <code>x-manychat-secret</code> in ManyChat.
          </li>
          <li>
            <span className="font-medium text-[var(--foreground)]">Add a ManyChat automation</span> —
            on new Instagram DM, POST subscriber id + message text to the webhook URL.
          </li>
          <li>
            <span className="font-medium text-[var(--foreground)]">Map your channel</span> — save the
            page/bot id under Messaging channels so traffic lands in this workspace.
          </li>
          <li>
            <span className="font-medium text-[var(--foreground)]">Validate configuration</span> —
            checks settings only; does not message anyone.
          </li>
          <li>
            <span className="font-medium text-[var(--foreground)]">Send a test DM</span> — optional,
            explicit, to a real subscriber who already messaged you.
          </li>
        </ol>

        <dl className="grid gap-3 text-sm md:grid-cols-2">
          <div>
            <dt className="text-[var(--muted)]">Webhook URL</dt>
            <dd className="mt-1 break-all font-mono text-xs">{status?.webhookUrl || "—"}</dd>
            {status?.webhookUrl && (
              <button type="button" className="btn btn-secondary mt-2" onClick={() => copy(status.webhookUrl)}>
                Copy URL
              </button>
            )}
          </div>
          <div>
            <dt className="text-[var(--muted)]">Inbound alias</dt>
            <dd className="mt-1 break-all font-mono text-xs">{status?.inboundAliasUrl || "—"}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Webhook secret</dt>
            <dd className="mt-1 font-mono text-xs">
              {status?.secretConfigured ? status.secretMasked : "not set"}
              {status?.secretSource ? ` (${status.secretSource})` : ""}
            </dd>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void regenerateSecret()}
              >
                Regenerate secret
              </button>
            </div>
            {oneTimeSecret && (
              <p className="mt-2 rounded-lg bg-[var(--surface-2)] p-2 font-mono text-xs">
                New secret (shown once): {oneTimeSecret}
                <button type="button" className="btn btn-secondary ml-2" onClick={() => copy(oneTimeSecret)}>
                  Copy
                </button>
              </p>
            )}
          </div>
          <div>
            <dt className="text-[var(--muted)]">API token</dt>
            <dd className="mt-1">
              <span className={status?.apiTokenConfigured ? "badge badge-success" : "badge badge-warn"}>
                {status?.apiTokenStatus ||
                  (status?.apiTokenConfigured ? "Configured" : "Not configured")}
              </span>
            </dd>
            <form onSubmit={saveApiToken} className="mt-2 flex flex-wrap gap-2">
              <input
                ref={apiTokenInputRef}
                className="input min-w-[12rem] flex-1 font-mono text-xs"
                type="password"
                autoComplete="off"
                value={apiTokenInput}
                onChange={(e) => setApiTokenInput(e.target.value)}
                placeholder={
                  status?.apiTokenConfigured ? "Paste new token to rotate" : "Paste ManyChat API token"
                }
              />
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {status?.apiTokenConfigured ? "Rotate token" : "Save token"}
              </button>
            </form>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Saved tokens are encrypted. We never return the plaintext after save.
            </p>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Last inbound event</dt>
            <dd className="mt-1 text-xs">
              {status?.lastInboundEvent
                ? `${status.lastInboundEvent.status} · ${new Date(status.lastInboundEvent.receivedAt).toLocaleString()}`
                : "None yet"}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Active channels</dt>
            <dd className="mt-1">{status?.channels.filter((c) => c.isActive).length ?? 0}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void validateConfiguration()}
          >
            Validate configuration
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void simulateInbound()}>
            Simulate inbound DM
          </button>
          {status?.connectionActive === false ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void reconnectManyChat()}
            >
              Reconnect ManyChat
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !status?.apiTokenConfigured}
              onClick={() => void disconnectManyChat()}
            >
              Disconnect ManyChat
            </button>
          )}
        </div>

        <form
          onSubmit={sendTestMessage}
          className="space-y-3 rounded-xl border border-[var(--border)] p-4"
        >
          <div>
            <h3 className="font-semibold">Send test message</h3>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Explicit live send to a real ManyChat subscriber who already has a conversation here.
              Uses the same outbound path as Inbox replies.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm md:col-span-1">
              Subscriber ID
              <input
                className="input mt-1"
                value={testContactExternalId}
                onChange={(e) => setTestContactExternalId(e.target.value)}
                placeholder="ManyChat subscriber_id"
                required
              />
            </label>
            <label className="text-sm md:col-span-1">
              Message (optional)
              <input
                className="input mt-1"
                value={testMessageText}
                onChange={(e) => setTestMessageText(e.target.value)}
                placeholder="Test message from Agent Desk"
              />
            </label>
            <div className="flex items-end">
              <button className="btn btn-primary w-full" type="submit" disabled={busy}>
                Send test message
              </button>
            </div>
          </div>
        </form>

        <p className="text-xs text-[var(--muted)]">
          Validate configuration never sends a DM. Simulate inbound stays inside the CRM. Send test
          message is the only control that delivers to Instagram.
        </p>
        {(status?.recentErrors?.length || 0) > 0 && (
          <div>
            <h3 className="font-semibold">Recent errors</h3>
            <ul className="mt-2 space-y-1 text-xs text-[var(--danger)]">
              {status?.recentErrors?.map((e) => (
                <li key={e.id}>
                  {e.status}: {e.error || "unknown"} · {new Date(e.receivedAt).toLocaleString()}
                </li>
              ))}
            </ul>
          </div>
        )}
        {status?.setup && (
          <details className="rounded-xl border border-[var(--border)] p-3 text-sm">
            <summary className="cursor-pointer font-medium">Technical payload reference</summary>
            <p className="mt-3 text-xs text-[var(--muted)]">
              Required fields: {status.setup.requiredFields.join(", ")}. Header:{" "}
              {status.setup.requiredHeaders.join(", ")}.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--surface-2)] p-3 text-xs">
              {JSON.stringify(status.setup.examplePayload, null, 2)}
            </pre>
          </details>
        )}
      </section>

      <section className="surface space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="h-display text-2xl">Booking webhooks</h2>
            <p className="text-sm text-[var(--muted)]">
              Confirmed bookings arrive separately from booking-link offers. Use these endpoints with
              header <code>x-booking-secret</code>.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={Boolean(testingId)}
            onClick={() => void testConnection("booking")}
          >
            Test connection
          </button>
        </div>
        <ul className="space-y-2 font-mono text-xs">
          <li>/api/webhooks/booking</li>
          <li>/api/integrations/booking/calendly/webhook</li>
          <li>/api/integrations/booking/calcom/webhook</li>
        </ul>
      </section>

      <section className="surface p-5">
        <h2 className="h-display text-2xl">Messaging channels</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Map your ManyChat / Instagram page id so inbound DMs resolve to this workspace.
        </p>
        <ul className="mt-3 space-y-2 text-sm">
          {(status?.channels || []).length === 0 && (
            <li className="text-[var(--muted)]">No channels configured yet.</li>
          )}
          {(status?.channels || []).map((ch) => (
            <li
              key={ch.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)]/50 py-2"
            >
              <div>
                <p className="font-medium">{ch.displayName}</p>
                <p className="text-[var(--muted)]">
                  {ch.provider} · {ch.externalId || "no external id"}
                  {ch.instagramUsername ? ` · @${ch.instagramUsername}` : ""}
                </p>
              </div>
              <span className={ch.isActive ? "badge badge-success" : "badge"}>
                {ch.isActive ? "Active" : "Inactive"}
              </span>
            </li>
          ))}
        </ul>
        <form onSubmit={saveChannel} className="mt-4 grid gap-3 md:grid-cols-4">
          <label className="text-sm">
            External ID
            <input
              className="input mt-1"
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              required
              placeholder="page or bot id"
            />
          </label>
          <label className="text-sm">
            Display name
            <input
              className="input mt-1"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Instagram page"
            />
          </label>
          <label className="flex items-end gap-2 text-sm">
            <input
              type="checkbox"
              className="mb-2 size-4"
              checked={channelActive}
              onChange={(e) => setChannelActive(e.target.checked)}
            />
            <span className="pb-2">Active</span>
          </label>
          <div className="flex items-end">
            <button className="btn btn-primary w-full" type="submit">
              Save channel
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
