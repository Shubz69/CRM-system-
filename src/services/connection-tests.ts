import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getOrganisationManyChatSecret } from "@/services/manychat-secrets";
import type { IntegrationType, Prisma } from "@prisma/client";
import IORedis from "ioredis";
import net from "net";
import { URL } from "url";

export const CONNECTION_TEST_IDS = [
  "database",
  "redis",
  "ai",
  "manychat",
  "booking",
  "email",
] as const;

export type ConnectionTestId = (typeof CONNECTION_TEST_IDS)[number];

export type ReadinessStatus =
  | "ready"
  | "untested"
  | "failed"
  | "missing"
  | "test_mode";

export type ConnectionTestRecord = {
  ok: boolean;
  testedAt: string;
  message: string;
};

export type IntegrationReadiness = {
  id: ConnectionTestId;
  label: string;
  description: string;
  status: ReadinessStatus;
  statusLabel: string;
  configured: boolean;
  usingTestMode: boolean;
  detail: string;
  lastTest: ConnectionTestRecord | null;
};

export type ConnectionTestResult = {
  id: ConnectionTestId;
  ok: boolean;
  message: string;
  testedAt: string;
  readiness: IntegrationReadiness;
};

type StoredTests = Partial<Record<ConnectionTestId, ConnectionTestRecord>>;

const LABELS: Record<
  ConnectionTestId,
  { label: string; description: string; integrationType?: IntegrationType }
> = {
  database: {
    label: "Database",
    description: "Where contacts, conversations, and bookings are stored.",
  },
  redis: {
    label: "Background jobs (Redis)",
    description:
      "Required for follow-ups and agent runs. Without it, the worker cannot run and those jobs never execute.",
  },
  ai: {
    label: "AI provider",
    description: "Powers qualification replies and conversation analysis.",
    integrationType: "ANTHROPIC",
  },
  manychat: {
    label: "ManyChat",
    description: "Brings Instagram DMs into the CRM and sends AI replies.",
    integrationType: "MANYCHAT",
  },
  booking: {
    label: "Booking",
    description: "Booking link offers and confirmed-booking webhooks.",
    integrationType: "BOOKING",
  },
  email: {
    label: "Email",
    description: "Optional outbound email for reports and alerts.",
    integrationType: "EMAIL",
  },
};

function statusLabel(status: ReadinessStatus): string {
  switch (status) {
    case "ready":
      return "Configured and verified";
    case "untested":
      return "Configured — not tested yet";
    case "failed":
      return "Configured — last test failed";
    case "missing":
      return "Not configured";
    case "test_mode":
      return "Test mode (not for live traffic)";
  }
}

/** Turn provider/network failures into plain English a non-technical user can act on. */
export function humanizeConnectionError(raw: string, context: ConnectionTestId): string {
  const text = raw.toLowerCase();

  if (/401|403|unauthorized|invalid.?api.?key|authentication|invalid.?x-api-key|rejected/.test(text)) {
    return "The API key was rejected. Check it was pasted correctly and has not been revoked.";
  }
  if (/402|payment|billing|quota|credit/.test(text)) {
    return "The provider account needs billing attention before we can connect.";
  }
  if (/429|rate.?limit|too many/.test(text)) {
    return "The provider asked us to slow down. Wait a minute and try again.";
  }
  if (/enotfound|getaddrinfo|dns/.test(text)) {
    return "We could not find that service online. Check the address or your network connection.";
  }
  if (/econnrefused|econnreset|etimedout|timeout|aborted|fetch failed|network/.test(text)) {
    if (context === "database") {
      return "We could not reach the database. Check the connection string and that the database is running.";
    }
    if (context === "redis") {
      return "We could not reach Redis. Check REDIS_URL — without a working Redis the worker cannot run.";
    }
    if (context === "email") {
      return "We could not reach the mail server. Check the host and port in your email settings.";
    }
    return "We could not reach the service. Check your network connection and try again.";
  }
  if (/404|not found/.test(text)) {
    return "We could not find that service endpoint. Check the provider URL setting.";
  }
  if (/5\d\d|internal server|bad gateway|unavailable/.test(text)) {
    return "The provider is having trouble right now. Try again in a few minutes.";
  }
  if (/ssl|cert|certificate/.test(text)) {
    return "The secure connection failed. Check the service URL uses https and is correct.";
  }

  const cleaned = raw
    .replace(/\s+/g, " ")
    .replace(/at\s+\S+\s+\([^)]+\)/g, "")
    .trim()
    .slice(0, 180);
  if (!cleaned) return "The connection check failed. Double-check your settings and try again.";
  return cleaned;
}

async function loadStoredTests(organisationId: string): Promise<StoredTests> {
  const [integrations, settings] = await Promise.all([
    prisma.integration.findMany({
      where: { organisationId },
      select: { type: true, name: true, config: true },
    }),
    prisma.systemSetting.findMany({
      where: { key: { in: ["connection_test:database", "connection_test:redis"] } },
    }),
  ]);

  const out: StoredTests = {};

  for (const row of settings) {
    const id = row.key.replace("connection_test:", "") as ConnectionTestId;
    const value = row.value as ConnectionTestRecord | null;
    if (value && typeof value === "object" && typeof value.testedAt === "string") {
      out[id] = value;
    }
  }

  for (const row of integrations) {
    const config = (row.config ?? {}) as {
      lastConnectionTest?: ConnectionTestRecord;
      connectionTestId?: ConnectionTestId;
    };
    const last = config.lastConnectionTest;
    if (!last?.testedAt) continue;

    if (row.type === "MANYCHAT") out.manychat = last;
    else if (row.type === "BOOKING") out.booking = last;
    else if (row.type === "EMAIL") out.email = last;
    else if (row.type === "OPENAI" || row.type === "ANTHROPIC") out.ai = last;
    else if (config.connectionTestId && CONNECTION_TEST_IDS.includes(config.connectionTestId)) {
      out[config.connectionTestId] = last;
    }
  }

  return out;
}

async function persistTest(
  organisationId: string,
  id: ConnectionTestId,
  record: ConnectionTestRecord,
): Promise<void> {
  if (id === "database" || id === "redis") {
    await prisma.systemSetting.upsert({
      where: { key: `connection_test:${id}` },
      create: { key: `connection_test:${id}`, value: record as unknown as Prisma.InputJsonValue },
      update: { value: record as unknown as Prisma.InputJsonValue },
    });
    return;
  }

  const env = getEnv();
  let type: IntegrationType = "WEBHOOK";
  if (id === "manychat") type = "MANYCHAT";
  else if (id === "booking") type = "BOOKING";
  else if (id === "email") type = "EMAIL";
  else if (id === "ai") {
    type = env.AI_PROVIDER === "openai" ? "OPENAI" : "ANTHROPIC";
  }

  const existing = await prisma.integration.findFirst({
    where: { organisationId, type, name: "default" },
  });

  const nextConfig = {
    ...((existing?.config as object) ?? {}),
    connectionTestId: id,
    lastConnectionTest: record,
  };

  if (existing) {
    await prisma.integration.update({
      where: { id: existing.id },
      data: { config: nextConfig as Prisma.InputJsonValue },
    });
  } else {
    await prisma.integration.create({
      data: {
        organisationId,
        type,
        name: "default",
        isActive: true,
        config: nextConfig as Prisma.InputJsonValue,
      },
    });
  }
}

function configurationState(_organisationId: string, id: ConnectionTestId, orgSecretConfigured: boolean) {
  const env = getEnv();

  switch (id) {
    case "database":
      return {
        configured: Boolean(env.DATABASE_URL),
        usingTestMode: false,
        detail: env.DATABASE_URL ? "Database URL is set." : "Add DATABASE_URL before going live.",
      };
    case "redis": {
      // Zod defaults REDIS_URL to localhost — treat only an explicit env value as configured.
      const configured = Boolean(process.env.REDIS_URL?.trim());
      return {
        configured,
        usingTestMode: false,
        detail: configured
          ? "Redis URL is set. Test to confirm the worker can reach it."
          : "Add REDIS_URL before going live. Without Redis, follow-ups and agent runs will not run.",
      };
    }
    case "ai": {
      const provider = (env.AI_PROVIDER || "mock").toLowerCase();
      if (provider === "mock") {
        return {
          configured: true,
          usingTestMode: true,
          detail:
            "AI is in test mode. Set AI_PROVIDER to anthropic or openai and add an API key before live traffic.",
        };
      }
      const hasKey =
        provider === "openai" ? Boolean(env.OPENAI_API_KEY) : Boolean(env.ANTHROPIC_API_KEY);
      return {
        configured: hasKey,
        usingTestMode: false,
        detail: hasKey
          ? `Using ${provider === "openai" ? "OpenAI" : "Anthropic"}.`
          : `Add the ${provider === "openai" ? "OpenAI" : "Anthropic"} API key in environment settings.`,
      };
    }
    case "manychat": {
      const hasToken = Boolean(env.MANYCHAT_API_TOKEN);
      const hasSecret = orgSecretConfigured || Boolean(env.MANYCHAT_WEBHOOK_SECRET);
      if (!hasToken && !hasSecret) {
        return {
          configured: false,
          usingTestMode: true,
          detail: "Add a ManyChat API token and webhook secret to leave test mode.",
        };
      }
      if (!hasToken) {
        return {
          configured: hasSecret,
          usingTestMode: true,
          detail:
            "Webhook secret is set, but no API token — outbound replies stay in test mode and will not reach Instagram.",
        };
      }
      return {
        configured: true,
        usingTestMode: false,
        detail: hasSecret
          ? "API token and webhook secret are set."
          : "API token is set. Add a webhook secret so inbound DMs can be verified.",
      };
    }
    case "booking": {
      const hasUrl = Boolean(env.DEFAULT_BOOKING_URL);
      const hasSecret = Boolean(env.BOOKING_WEBHOOK_SECRET);
      const provider = (env.BOOKING_PROVIDER || "link").toLowerCase();
      if (provider === "mock") {
        return {
          configured: true,
          usingTestMode: true,
          detail:
            "Booking is in test mode. Set BOOKING_PROVIDER to link and add your booking URL before live traffic.",
        };
      }
      return {
        configured: hasUrl && hasSecret,
        usingTestMode: false,
        detail:
          hasUrl && hasSecret
            ? "Booking link and webhook secret are set."
            : !hasUrl
              ? "Add DEFAULT_BOOKING_URL (your Calendly or booking page)."
              : "Add BOOKING_WEBHOOK_SECRET so confirmed bookings can be verified.",
      };
    }
    case "email": {
      const hasSmtp = Boolean(env.EMAIL_SMTP_URL);
      const hasFrom = Boolean(env.EMAIL_FROM);
      return {
        configured: hasSmtp && hasFrom,
        usingTestMode: false,
        detail: hasSmtp
          ? hasFrom
            ? "Mail server settings are present."
            : "Add EMAIL_FROM (the From address)."
          : "Optional. Add EMAIL_SMTP_URL and EMAIL_FROM to send live email.",
      };
    }
  }
}

function buildReadinessItem(
  id: ConnectionTestId,
  organisationId: string,
  orgSecretConfigured: boolean,
  lastTest: ConnectionTestRecord | null,
): IntegrationReadiness {
  const meta = LABELS[id];
  const config = configurationState(organisationId, id, orgSecretConfigured);

  let status: ReadinessStatus;
  if (config.usingTestMode && (id === "ai" || id === "manychat" || id === "booking")) {
    status = "test_mode";
  } else if (!config.configured) {
    status = "missing";
  } else if (!lastTest) {
    status = "untested";
  } else if (lastTest.ok) {
    status = "ready";
  } else {
    status = "failed";
  }

  return {
    id,
    label: meta.label,
    description: meta.description,
    status,
    statusLabel: statusLabel(status),
    configured: config.configured,
    usingTestMode: config.usingTestMode,
    detail: config.detail,
    lastTest,
  };
}

export async function getIntegrationReadiness(
  organisationId: string,
): Promise<{ items: IntegrationReadiness[]; goLiveReady: boolean; summary: string }> {
  const orgSecret = await getOrganisationManyChatSecret(organisationId);
  const stored = await loadStoredTests(organisationId);
  const items = CONNECTION_TEST_IDS.map((id) =>
    buildReadinessItem(id, organisationId, Boolean(orgSecret), stored[id] ?? null),
  );

  const required = items.filter(
    (i) =>
      i.id === "database" ||
      i.id === "redis" ||
      i.id === "ai" ||
      i.id === "manychat" ||
      i.id === "booking",
  );
  const blockers = required.filter((i) => i.status !== "ready");
  const goLiveReady = blockers.length === 0;

  let summary: string;
  if (goLiveReady) {
    summary = "Core connections are configured and verified. You are ready to go live.";
  } else {
    const n = blockers.length;
    summary = `${n} core item${n === 1 ? "" : "s"} still need attention before going live.`;
  }

  return { items, goLiveReady, summary };
}

async function testDatabase(): Promise<{ ok: boolean; message: string }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, message: "Database responded successfully." };
  } catch (error) {
    return {
      ok: false,
      message: humanizeConnectionError(
        error instanceof Error ? error.message : "Database check failed",
        "database",
      ),
    };
  }
}

async function testRedis(): Promise<{ ok: boolean; message: string }> {
  const explicitUrl = process.env.REDIS_URL?.trim();
  if (!explicitUrl) {
    return {
      ok: false,
      message:
        "No Redis address is set. Add REDIS_URL — without it the worker cannot run, so follow-ups and agent runs will never execute.",
    };
  }

  // Match the production worker connection options (src/workers/index.ts + followups.ts).
  let redis: IORedis | null = null;
  let queue: { close: () => Promise<void> } | null = null;
  try {
    redis = new IORedis(explicitUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      connectTimeout: 2000,
    });
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== "PONG") {
      return {
        ok: false,
        message:
          "Redis answered, but not in the way the worker expects. Check REDIS_URL and that Redis is healthy.",
      };
    }

    // Prove BullMQ can open the same queue the worker uses — not merely that the URL parses.
    // Redis PING above already verified the client; waitUntilReady proves the queue wiring.
    const { Queue } = await import("bullmq");
    const { getBullMqPrefix } = await import("@/jobs/redis");
    const followUpsQueue = new Queue("follow-ups", { connection: redis, prefix: getBullMqPrefix() });
    queue = followUpsQueue;
    await followUpsQueue.waitUntilReady();

    return {
      ok: true,
      message: "Redis is reachable and the worker queue can connect. No jobs were run.",
    };
  } catch (error) {
    return {
      ok: false,
      message: humanizeConnectionError(
        error instanceof Error ? error.message : "Redis check failed",
        "redis",
      ),
    };
  } finally {
    await queue?.close().catch(() => undefined);
    await redis?.quit().catch(() => undefined);
  }
}

async function testAi(): Promise<{ ok: boolean; message: string }> {
  const env = getEnv();
  const provider = (env.AI_PROVIDER || "mock").toLowerCase();

  if (provider === "mock") {
    return {
      ok: true,
      message:
        "AI test mode is working. Switch AI_PROVIDER to anthropic or openai and add an API key before live traffic.",
    };
  }

  try {
    if (provider === "openai") {
      if (!env.OPENAI_API_KEY) {
        return {
          ok: false,
          message: "No OpenAI API key is set. Add OPENAI_API_KEY in environment settings.",
        };
      }
      const response = await fetch("https://api.openai.com/v1/models?limit=1", {
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      });
      if (!response.ok) {
        const body = await response.text();
        return {
          ok: false,
          message: humanizeConnectionError(`OpenAI ${response.status} ${body}`, "ai"),
        };
      }
      return { ok: true, message: "OpenAI accepted the API key." };
    }

    if (provider === "anthropic") {
      if (!env.ANTHROPIC_API_KEY) {
        return {
          ok: false,
          message: "No Anthropic API key is set. Add ANTHROPIC_API_KEY in environment settings.",
        };
      }
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-3-5-haiku-latest",
          max_tokens: 1,
          messages: [{ role: "user", content: "." }],
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        return {
          ok: false,
          message: humanizeConnectionError(`Anthropic ${response.status} ${body}`, "ai"),
        };
      }
      return { ok: true, message: "Anthropic accepted the API key." };
    }

    return {
      ok: false,
      message: `Unknown AI provider "${provider}". Use anthropic, openai, or mock.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: humanizeConnectionError(error instanceof Error ? error.message : "AI check failed", "ai"),
    };
  }
}

async function testManyChat(organisationId: string): Promise<{ ok: boolean; message: string }> {
  const env = getEnv();
  const orgSecret = await getOrganisationManyChatSecret(organisationId);
  const hasSecret = Boolean(orgSecret || env.MANYCHAT_WEBHOOK_SECRET);

  if (!env.MANYCHAT_API_TOKEN) {
    if (hasSecret) {
      return {
        ok: false,
        message:
          "Webhook secret is set, but there is no ManyChat API token. Outbound replies will stay in test mode and will not reach Instagram.",
      };
    }
    return {
      ok: false,
      message: "ManyChat is not configured. Add an API token and webhook secret to connect Instagram DMs.",
    };
  }

  try {
    const base = env.MANYCHAT_API_BASE_URL.replace(/\/$/, "");
    const response = await fetch(`${base}/fb/page/getInfo`, {
      headers: {
        Authorization: `Bearer ${env.MANYCHAT_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        message: humanizeConnectionError(`ManyChat ${response.status} ${body}`, "manychat"),
      };
    }
    if (!hasSecret) {
      return {
        ok: true,
        message:
          "ManyChat API token works. Add a webhook secret next so inbound DMs can be verified safely.",
      };
    }
    return { ok: true, message: "ManyChat accepted the API token. No messages were sent." };
  } catch (error) {
    return {
      ok: false,
      message: humanizeConnectionError(
        error instanceof Error ? error.message : "ManyChat check failed",
        "manychat",
      ),
    };
  }
}

async function testBooking(): Promise<{ ok: boolean; message: string }> {
  const env = getEnv();
  const provider = (env.BOOKING_PROVIDER || "link").toLowerCase();

  if (provider === "mock") {
    return {
      ok: true,
      message: "Booking test mode is working. Set a real booking link before live traffic.",
    };
  }

  if (!env.DEFAULT_BOOKING_URL) {
    return {
      ok: false,
      message: "No booking page URL is set. Add DEFAULT_BOOKING_URL (for example your Calendly link).",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(env.DEFAULT_BOOKING_URL);
  } catch {
    return {
      ok: false,
      message: "The booking page URL is not valid. It should start with https://",
    };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, message: "The booking page URL must start with https://" };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "DM-Intelligence-Connection-Test/1.0" },
    });
    clearTimeout(timer);

    if (response.status >= 400 && response.status !== 401 && response.status !== 403) {
      return {
        ok: false,
        message: humanizeConnectionError(`Booking page ${response.status}`, "booking"),
      };
    }

    if (!env.BOOKING_WEBHOOK_SECRET) {
      return {
        ok: true,
        message:
          "Booking page is reachable. Add BOOKING_WEBHOOK_SECRET so confirmed bookings can be trusted.",
      };
    }

    const isDefaultSecret = env.BOOKING_WEBHOOK_SECRET === "dev-booking-webhook-secret";
    if (isDefaultSecret && env.NODE_ENV === "production") {
      return {
        ok: false,
        message: "Replace the default booking webhook secret with a unique secret before going live.",
      };
    }

    return { ok: true, message: "Booking page is reachable and the webhook secret is set." };
  } catch (error) {
    return {
      ok: false,
      message: humanizeConnectionError(
        error instanceof Error ? error.message : "Booking check failed",
        "booking",
      ),
    };
  }
}

function tcpConnect(host: string, port: number, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => {
      socket.end();
      resolve();
    });
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
    socket.on("error", (err) => reject(err));
  });
}

async function testEmail(): Promise<{ ok: boolean; message: string }> {
  const env = getEnv();
  if (!env.EMAIL_SMTP_URL) {
    return {
      ok: false,
      message: "Email is not configured. Add EMAIL_SMTP_URL if you want the CRM to send email.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(env.EMAIL_SMTP_URL);
  } catch {
    return {
      ok: false,
      message: "The email server address is not valid. Use a URL like smtp://user:pass@mail.example.com:587",
    };
  }

  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "smtps:" ? 465 : 587;
  if (!host) {
    return { ok: false, message: "The email server address is missing a host name." };
  }

  try {
    await tcpConnect(host, port);
    if (!env.EMAIL_FROM) {
      return {
        ok: true,
        message: "Mail server is reachable. Add EMAIL_FROM so messages have a From address.",
      };
    }
    return {
      ok: true,
      message: "Mail server is reachable. No email was sent.",
    };
  } catch (error) {
    return {
      ok: false,
      message: humanizeConnectionError(
        error instanceof Error ? error.message : "Email check failed",
        "email",
      ),
    };
  }
}

export async function runConnectionTest(
  organisationId: string,
  id: ConnectionTestId,
): Promise<ConnectionTestResult> {
  let outcome: { ok: boolean; message: string };
  switch (id) {
    case "database":
      outcome = await testDatabase();
      break;
    case "redis":
      outcome = await testRedis();
      break;
    case "ai":
      outcome = await testAi();
      break;
    case "manychat":
      outcome = await testManyChat(organisationId);
      break;
    case "booking":
      outcome = await testBooking();
      break;
    case "email":
      outcome = await testEmail();
      break;
    default:
      outcome = { ok: false, message: "Unknown integration." };
  }

  const testedAt = new Date().toISOString();
  const record: ConnectionTestRecord = {
    ok: outcome.ok,
    testedAt,
    message: outcome.message,
  };
  await persistTest(organisationId, id, record);

  const { items } = await getIntegrationReadiness(organisationId);
  const readiness = items.find((i) => i.id === id)!;

  return {
    id,
    ok: outcome.ok,
    message: outcome.message,
    testedAt,
    readiness,
  };
}
