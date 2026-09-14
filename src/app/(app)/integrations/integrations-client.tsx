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
  organisationId?: string;
  webhookUrl: string;
  inboundAliasUrl?: string;
  secretConfigured: boolean;
  inboundAuthRequired?: boolean;
  inboundCapabilityStatus?: "AUTH_REQUIRED" | "CONNECTED";
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
    if (res.status === 401 || res.status === 403) {
      setStatus(null);
      return;
    }
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load messaging");
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
      // Social Accounts stay primary; Messaging setup loads so inbound webhook secrets can be configured.
      const providersPromise = fetch("/api/health/providers");
      await Promise.all([loadSocialAccounts(), loadMessaging()]);
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
  }, [loadSocialAccounts, loadMessaging]);

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
              Connect Instagram, LinkedIn, and YouTube through Zernio. Native Instagram/LinkedIn/TikTok
              OAuth is a separate admin path and is not required for these accounts.
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
                          <li>Connected via Zernio</li>
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
                      {platform === "instagram" ? (
                        <button
                          type="button"
                          className="btn btn-secondary text-xs"
                          onClick={() => focusMessagingSetup()}
                        >
                          Messaging setup
                        </button>
                      ) : null}
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
              <div className="flex flex-wrap items-start justify-between gap-2 border-t border-[var(--border)] pt-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span>TikTok</span>
                    <span className="badge">Not connected</span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Native TikTok Connect is not offered here. It requires TIKTOK_CLIENT_KEY,
                    TIKTOK_CLIENT_SECRET, and TIKTOK_REDIRECT_URI. Public listen uses Apify when
                    configured — no invented login.
                  </p>
                </div>
              </div>
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

      <section
        id={MANYCHAT_SETUP_ID}
        ref={messagingSetupRef}
        tabIndex={-1}
        className="surface scroll-mt-24 space-y-4 p-5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-[family-name:var(--font-fraunces)] text-lg">Messaging setup</h2>
            <p className="text-sm text-[var(--muted)]">
              Configure inbound Instagram DMs: organisation webhook secret, webhook URL, and API
              token. Social Accounts above stay the primary connect surface.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={status?.connected ? "badge badge-success" : "badge badge-warn"}>
              {status?.connected ? "Connected" : "Not connected"}
            </span>
            {status?.inboundAuthRequired ||
            status?.inboundCapabilityStatus === "AUTH_REQUIRED" ||
            (status && !status.secretConfigured) ? (
              <span className="badge badge-warn">AUTH_REQUIRED</span>
            ) : null}
            {status?.connectionActive === false && (
              <span className="badge badge-warn">Disconnected</span>
            )}
          </div>
        </div>

        {status && !status.secretConfigured ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/60 p-4">
            <p className="font-medium">First-run inbound checklist</p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Inbound receive is <span className="font-medium text-[var(--foreground)]">AUTH_REQUIRED</span>{" "}
              until this workspace has its own webhook secret. The environment secret cannot authorize
              another organisation&apos;s events.
            </p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-[var(--muted)]">
              <li>Copy the webhook URL and organisationId below.</li>
              <li>Click Regenerate secret and store header x-manychat-secret on the inbound request.</li>
              <li>Include organisationId on every payload so events land in this workspace only.</li>
            </ol>
          </div>
        ) : null}

        <ol className="list-decimal space-y-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-4 pl-8 text-sm text-[var(--muted)]">
          <li>
            <span className="font-medium text-[var(--foreground)]">Copy the webhook URL</span> and
            include <code>organisationId</code> on every inbound payload so events land in this
            workspace.
          </li>
          <li>
            <span className="font-medium text-[var(--foreground)]">Regenerate the webhook secret</span>{" "}
            — copy it once, then send header <code>x-manychat-secret</code> on the inbound request.
            Without an organisation secret, inbound receive stays AUTH_REQUIRED for this workspace.
          </li>
          <li>
            <span className="font-medium text-[var(--foreground)]">Paste your API token</span> for
            outbound replies. Tokens are stored encrypted and never shown again.
          </li>
          <li>
            <span className="font-medium text-[var(--foreground)]">Test inbound</span> processes a
            sample message inside the CRM only — nothing is sent to Instagram.
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
            <dt className="text-[var(--muted)]">organisationId</dt>
            <dd className="mt-1 break-all font-mono text-xs">
              {status?.organisationId ||
                (typeof status?.setup?.examplePayload?.organisationId === "string"
                  ? status.setup.examplePayload.organisationId
                  : "—")}
            </dd>
            {(status?.organisationId ||
              typeof status?.setup?.examplePayload?.organisationId === "string") && (
              <button
                type="button"
                className="btn btn-secondary mt-2"
                onClick={() =>
                  copy(
                    status.organisationId ||
                      String(status.setup?.examplePayload?.organisationId || ""),
                  )
                }
              >
                Copy organisationId
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
              {status?.secretSource && status.secretSource !== "none"
                ? ` (${status.secretSource})`
                : ""}
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
                  status?.apiTokenConfigured ? "Paste new token to rotate" : "Paste messaging API token"
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
        </dl>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void simulateInbound()}
          >
            Test inbound
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void validateConfiguration()}
          >
            Validate configuration
          </button>
          {status?.connectionActive === false ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void reconnectMessaging()}
            >
              Reconnect messaging
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !status?.apiTokenConfigured}
              onClick={() => void disconnectMessaging()}
            >
              Disconnect messaging
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
              Explicit live send to a real messaging subscriber who already has a conversation here.
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
                placeholder="subscriber_id"
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
          Test inbound stays inside the CRM. Validate configuration never sends a DM. Send test
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

      <section className="surface p-5">
        <h2 className="font-[family-name:var(--font-fraunces)] text-lg">Messaging channels</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Map your Instagram page or bot id so inbound DMs resolve to this workspace.
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
