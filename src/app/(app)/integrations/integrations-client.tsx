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

type MessagingStatus = {
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
    duplicateMessagingRisk: boolean;
  };
  reconnectHint: string | null;
};

/**
 * Messaging for Instagram: connect above or messaging setup below.
 * LinkedIn / TikTok have no compliant third-party DM API.
 */
function messagingNote(slug: string): string {
  if (slug === "instagram") return "via Connect above or messaging setup below";
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

const MANYCHAT_SETUP_ID = "messaging-setup";

export default function IntegrationsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const messagingSetupRef = useRef<HTMLElement | null>(null);
  const apiTokenInputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<MessagingStatus | null>(null);
  const [metaIg, setMetaIg] = useState<MetaInstagramStatus | null>(null);
  const [alternateSocial, setAlternateSocial] = useState<{
    configured?: boolean;
    serverConfigured?: boolean;
    status?: string;
  } | null>(null);
  void alternateSocial;
  const [socialAccounts, setSocialAccounts] = useState<{
    serverConfigured?: boolean;
    status?: string;
    healed?: boolean;
    connectionPolicy?: {
      socialConnectionsEnabled?: boolean;
      maxConnectedSocialAccounts?: number | null;
      allowedNetworks?: string[];
      connectedCount?: number;
    };
    networks?: {
      instagram?: {
        connected?: boolean;
        status?: string;
        username?: string | null;
        displayName?: string | null;
        accountType?: string | null;
        health?: string;
        requiresFacebookPage?: boolean;
      };
      linkedin?: {
        connected?: boolean;
        status?: string;
        username?: string | null;
        displayName?: string | null;
        accountType?: string | null;
        health?: string;
        dmCapability?: string;
      };
      youtube?: {
        connected?: boolean;
        status?: string;
        username?: string | null;
        displayName?: string | null;
        accountType?: string | null;
        health?: string;
        dmCapability?: string;
      };
    };
    connectedAccounts?: Array<{ platform?: string; displayName?: string; username?: string }>;
  } | null>(null);
  const [disconnectConfirm, setDisconnectConfirm] = useState<
    "instagram" | "linkedin" | "youtube" | null
  >(null);
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

  const loadAlternateSocial = useCallback(async () => {
    const res = await fetch("/api/integrations/ayrshare");
    if (!res.ok) {
      setAlternateSocial(null);
      return;
    }
    setAlternateSocial(await res.json());
  }, []);

  const loadSocialAccounts = useCallback(async () => {
    const res = await fetch("/api/integrations/zernio");
    if (!res.ok) {
      setSocialAccounts(null);
      return;
    }
    setSocialAccounts(await res.json());
  }, []);

  const loadMessaging = useCallback(async () => {
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
      // Customer surface: Social Accounts only. Provider internals stay platform-admin.
      const providersPromise = fetch("/api/health/providers");
      await Promise.all([loadSocialAccounts()]);
      const providersRes = await providersPromise;
      if (providersRes.ok) {
        const p = await providersRes.json();
        setAiReady(
          Boolean(
            p.providers?.ai?.ready || p.providers?.ai?.status === "AVAILABLE",
          ),
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }, [loadSocialAccounts]);

  useEffect(() => {
    void load();
  }, [load]);

  const focusMessagingSetup = useCallback((opts?: { focusToken?: boolean }) => {
    const el = messagingSetupRef.current || document.getElementById(MANYCHAT_SETUP_ID);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    if (typeof el.focus === "function") {
      el.focus({ preventScroll: true });
    }
    if (opts?.focusToken) {
      window.setTimeout(() => apiTokenInputRef.current?.focus(), 350);
    }
  }, []);

  // One journey: Instagram Configure / Set up â†’ Messaging setup section.
  useEffect(() => {
    if (loading) return;
    const setup = searchParams.get("setup");
    const hash =
      typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
    if (setup === "messaging" || hash === MANYCHAT_SETUP_ID) {
      focusMessagingSetup({ focusToken: setup === "messaging" });
    }
  }, [loading, searchParams, focusMessagingSetup]);

  // /api/social/[platform]/callback, Social OAuth, and Instagram OAuth redirect here —
  // surface once, force social revalidation, then strip from the URL so a refresh doesn't repeat it.
  useEffect(() => {
    const connected = searchParams.get("social_connected");
    const error = searchParams.get("social_error");
    const socialSync = searchParams.get("social_sync");
    const socialStatus = searchParams.get("social_status");
    const metaStatus = searchParams.get("meta_instagram");
    const metaError = searchParams.get("meta_instagram_error");
    if (!connected && !error && !metaStatus && !socialSync) return;

    void (async () => {
      if (connected || socialSync === "needed") {
        try {
          await fetch("/api/integrations/zernio", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "sync" }),
          });
        } catch {
          /* bounded sync best-effort */
        }
        await loadSocialAccounts();
      }
      if (connected) {
        const label = connected
          .split(",")
          .map((p) =>
            p === "instagram"
              ? "Instagram"
              : p === "linkedin"
                ? "LinkedIn"
                : p === "youtube"
                  ? "YouTube"
                  : p,
          )
          .join(" & ");
        toast.success(`${label} connected`);
      } else if (socialSync === "needed") {
        if (socialStatus === "DEGRADED") {
          toast.error(error || "Account linked but sync needs attention — status refreshed");
        } else {
          toast.message("Finishing account sync…");
        }
      } else if (error) {
        toast.error(error);
      }
      if (metaStatus === "connected") toast.success("Instagram messaging connected");
      else if (metaStatus === "incomplete")
        toast.error(metaError || "Instagram connected but setup is incomplete");
      else if (metaStatus === "not_configured")
        toast.error("Instagram app is not configured on the server");
      else if (metaStatus === "denied") toast.error(metaError || "Instagram connection denied");
      else if (metaStatus === "error") toast.error(metaError || "Instagram connection failed");
      if (metaStatus === "connected" || metaStatus === "incomplete") {
        void loadMetaInstagram();
      }
      router.replace("/integrations");
    })();
  }, [searchParams, router, loadMetaInstagram, loadSocialAccounts]);

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
        provider: "messaging",
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

  async function messagingAction(action: string, payload: Record<string, unknown> = {}) {
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
      toast.error("Paste your messaging API token first");
      return;
    }
    setBusy(true);
    try {
      const json = await messagingAction("save_api_token", { apiToken: apiTokenInput.trim() });
      setApiTokenInput("");
      toast.success(json.message || "API token saved");
      await loadMessaging();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save token");
    } finally {
      setBusy(false);
    }
  }

  async function disconnectMessaging() {
    setBusy(true);
    try {
      const json = await messagingAction("disconnect");
      toast.success(json.message || "Messaging disconnected");
      await loadMessaging();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not disconnect");
    } finally {
      setBusy(false);
    }
  }

  async function reconnectMessaging() {
    setBusy(true);
    try {
      const json = await messagingAction("reconnect");
      toast.success(json.message || "Messaging reconnected");
      await loadMessaging();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reconnect");
    } finally {
      setBusy(false);
    }
  }

  async function validateConfiguration() {
    setBusy(true);
    try {
      const json = await messagingAction("validate_configuration");
      if (json.ok) toast.success(json.message || "Configuration valid — no message sent");
      else toast.error(json.message || "Configuration incomplete");
      await loadMessaging();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Validation failed");
    } finally {
      setBusy(false);
    }
  }

  async function sendTestMessage(e: FormEvent) {
    e.preventDefault();
    if (!testContactExternalId.trim()) {
      toast.error("Enter a real messaging subscriber ID");
      return;
    }
    setBusy(true);
    try {
      const json = await messagingAction("send_test_message", {
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
      const json = await messagingAction("regenerate_secret");
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
      await messagingAction("test_inbound");
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
        <h2 className="font-[family-name:var(--font-fraunces)] text-lg">Social Accounts</h2>
        <p className="text-sm text-[var(--muted)]">
          What is live for this workspace right now.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-xl border border-[var(--border)] p-4">
            <p className="font-medium">Social Accounts</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Connect Instagram, LinkedIn, and YouTube. Capability readiness is shown per account.
            </p>
            <div className="mt-3 space-y-3 text-sm">
              {(["instagram", "linkedin", "youtube"] as const).map((platform) => {
                const net =
                  platform === "instagram"
                    ? socialAccounts?.networks?.instagram
                    : platform === "linkedin"
                      ? socialAccounts?.networks?.linkedin
                      : socialAccounts?.networks?.youtube;
                const label =
                  platform === "instagram"
                    ? "Instagram"
                    : platform === "linkedin"
                      ? "LinkedIn"
                      : "YouTube";
                const status = net?.status || (net?.connected ? "CONNECTED" : "DISCONNECTED");
                const connected = status === "CONNECTED";
                const degraded =
                  status === "DEGRADED" || status === "REAUTH_REQUIRED" || status === "CONNECTING";
                const identity =
                  platform === "instagram"
                    ? net?.username
                      ? `@${net.username.replace(/^@/, "")}`
                      : net?.displayName || null
                    : net?.displayName || (net?.username ? net.username : null);
                const typeHint = net?.accountType;
                const networkAllowed =
                  !socialAccounts?.connectionPolicy?.allowedNetworks ||
                  socialAccounts.connectionPolicy.allowedNetworks.includes(
                    platform === "instagram"
                      ? "INSTAGRAM"
                      : platform === "linkedin"
                        ? "LINKEDIN"
                        : "YOUTUBE",
                  );
                return (
                  <div key={platform} className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{label}</span>
                        {connected ? (
                          <span className="badge badge-success">Connected</span>
                        ) : degraded ? (
                          <span className="badge">{status.replace(/_/g, " ")}</span>
                        ) : (
                          <span className="badge">Not connected</span>
                        )}
                      </div>
                      {identity ? (
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          {identity}
                          {typeHint ? ` · ${typeHint}` : ""}
                        </p>
                      ) : null}
                      {connected ? (
                        <ul className="mt-2 space-y-0.5 text-xs text-[var(--muted)]">
                          <li>Publishing · Available</li>
                          <li>Analytics · Available</li>
                          <li>
                            {platform === "instagram"
                              ? "Messaging · Available"
                              : "Outreach · Open + Copy"}
                          </li>
                        </ul>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {connected || status === "REAUTH_REQUIRED" ? (
                        <button
                          type="button"
                          className="btn btn-secondary text-xs"
                          disabled={busy || !socialAccounts?.serverConfigured}
                          onClick={() => setDisconnectConfirm(platform)}
                        >
                          Disconnect
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary text-xs"
                          disabled={
                            busy ||
                            !socialAccounts?.serverConfigured ||
                            socialAccounts?.connectionPolicy?.socialConnectionsEnabled === false ||
                            !networkAllowed
                          }
                          onClick={async () => {
                            setBusy(true);
                            try {
                              const res = await fetch("/api/integrations/zernio", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ action: "connect", platform }),
                              });
                              const json = await res.json();
                              if (!res.ok) {
                                if (json.code === "SOCIAL_CONNECTION_QUOTA") {
                                  throw new Error(
                                    json.error ||
                                      "Your workspace has reached its connected-account limit.",
                                  );
                                }
                                throw new Error(json.error || `Could not start ${label} connect`);
                              }
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
                      )}
                    </div>
                  </div>
                );
              })}
              {!socialAccounts?.serverConfigured &&
              !["instagram", "linkedin", "youtube"].some((p) => {
                const net =
                  p === "instagram"
                    ? socialAccounts?.networks?.instagram
                    : p === "linkedin"
                      ? socialAccounts?.networks?.linkedin
                      : socialAccounts?.networks?.youtube;
                return net?.status === "CONNECTED" || net?.connected;
              }) ? (
                <p className="text-xs text-[var(--muted)]">
                  Connecting new accounts is temporarily unavailable.
                </p>
              ) : null}
              {socialAccounts?.connectionPolicy?.maxConnectedSocialAccounts != null ? (
                <p className="text-xs text-[var(--muted)]">
                  Connected accounts: {socialAccounts.connectionPolicy.connectedCount ?? 0} /{" "}
                  {socialAccounts.connectionPolicy.maxConnectedSocialAccounts}
                </p>
              ) : null}
            </div>
            {disconnectConfirm ? (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                <div
                  role="dialog"
                  aria-modal="true"
                  className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-lg"
                >
                  <p className="text-lg font-medium">
                    Disconnect{" "}
                    {disconnectConfirm === "instagram"
                      ? "Instagram"
                      : disconnectConfirm === "linkedin"
                        ? "LinkedIn"
                        : "YouTube"}
                    ?
                  </p>
                  <p className="mt-2 text-sm text-[var(--muted)]">
                    This stops Agent Desk from publishing, receiving new messages, and
                    accessing this account until you reconnect. Existing CRM history and previous
                    conversations will remain.
                  </p>
                  <div className="mt-4 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="btn btn-secondary text-xs"
                      disabled={busy}
                      onClick={() => setDisconnectConfirm(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary text-xs"
                      disabled={busy}
                      onClick={async () => {
                        const platform = disconnectConfirm;
                        setBusy(true);
                        try {
                          const res = await fetch("/api/integrations/zernio", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action: "disconnect", platform }),
                          });
                          const json = await res.json();
                          if (!res.ok) {
                            if (json.code === "RECONCILIATION_REQUIRED") {
                              toast.error(
                                json.error ||
                                  "Disconnect could not be confirmed — status not changed to disconnected",
                              );
                              await loadSocialAccounts();
                              setDisconnectConfirm(null);
                              return;
                            }
                            throw new Error(json.error || "Disconnect failed");
                          }
                          toast.success(
                            `${
                              platform === "instagram"
                                ? "Instagram"
                                : platform === "linkedin"
                                  ? "LinkedIn"
                                  : "YouTube"
                            } disconnected`,
                          );
                          setDisconnectConfirm(null);
                          await loadSocialAccounts();
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : "Disconnect failed");
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Disconnect account
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          
          <div className="rounded-xl border border-[var(--border)] p-4">
            <p className="font-medium">Agent Desk intelligence</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Brand voice, reply tone, and automation preferences
            </p>
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

    </div>
  );
}
